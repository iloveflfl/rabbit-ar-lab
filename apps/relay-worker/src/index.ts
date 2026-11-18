/**
 * Rabbit AR relay — Cloudflare Worker + Durable Object.
 *
 *   GET  /health          공개. online | offline | busy 정도만 알려 준다.
 *   WSS  /v1/chat         관람객. 세션별로 격리된 채팅(스트리밍).
 *   POST /v1/chat         관람객. WebSocket 을 못 쓰는 환경용 단발 요청.
 *   WSS  /device/connect  전시 단말 전용. Authorization: Bearer <DEVICE_TOKEN>.
 *   GET  /device/status   소유자 전용 상세 상태(같은 토큰).
 *
 * Worker 와 Durable Object 는 메시지를 전달만 한다. LLM 은 여기서 돌지 않는다.
 */
import { DurableObject } from 'cloudflare:workers';
import { CLIENT_VERSION, LIMITS } from '@rabbit/shared';
import { type Budget, type Conn, type ConnMeta, RelayCore } from './core';

export interface Env {
  RELAY: DurableObjectNamespace<RelayRoom>;
  /** wrangler secret put DEVICE_TOKEN — 코드·저장소에 넣지 않는다. */
  DEVICE_TOKEN?: string;
  /** 쉼표로 구분한 허용 Origin. 비우면 모든 Origin 허용(개발용). CORS 는 보조 수단일 뿐 인증이 아니다. */
  ALLOWED_ORIGINS?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function originAllowed(req: Request, env: Env): boolean {
  const list = allowedOrigins(env);
  if (list.length === 0) return true;
  const origin = req.headers.get('Origin');
  return origin !== null && list.includes(origin);
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const list = allowedOrigins(env);
  const origin = req.headers.get('Origin');
  const allow = list.length === 0 ? '*' : origin && list.includes(origin) ? origin : list[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** 길이·내용 누출을 줄이기 위해 해시끼리 상수 시간으로 비교한다. */
async function tokenMatches(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 24 || !given) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    const known = ['/health', '/v1/chat', '/device/connect', '/device/status'];
    if (!known.includes(url.pathname)) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { ...JSON_HEADERS, ...corsHeaders(req, env) } });
    }
    // 전시 하나 = 방 하나. 이름이 고정이라 주소도 고정이다.
    try {
      const stub = env.RELAY.get(env.RELAY.idFromName('exhibition'));
      return await stub.fetch(req);
    } catch (e) {
      // 방(Durable Object)이 재시작 중이거나 과부하일 때. 클라이언트는 이 응답을 보고 다시 시도한다.
      console.error('relay fetch error', e);
      return new Response(JSON.stringify({ error: 'relay_unavailable' }), { status: 503, headers: { ...JSON_HEADERS, ...corsHeaders(req, env), 'retry-after': '2' } });
    }
  },
} satisfies ExportedHandler<Env>;

export class RelayRoom extends DurableObject<Env> {
  private readonly core: RelayCore;
  private readonly conns = new Map<WebSocket, Conn>();
  private seq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new RelayCore({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      version: CLIENT_VERSION,
      onBudgetChange: (b) => {
        void this.ctx.storage.put('budget', b);
      },
    });
    // ping 은 객체를 깨우지 않고 런타임이 바로 답한다.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    void this.ctx.blockConcurrencyWhile(async () => {
      this.core.loadBudget(await this.ctx.storage.get<Budget>('budget'));
    });
    // 휴면에서 깨어났다면 살아 있는 소켓을 다시 등록한다.
    // 단말 소켓이 둘 이상 남아 있을 수 있다(끊긴 줄 모르고 남은 옛 연결 + 다시 붙은 새 연결).
    // 예전에는 순서대로 등록하면서 뒤의 것이 앞의 것을 밀어냈는데, 그 순서가 뒤집히면
    // 멀쩡한 새 연결을 "다른 서버가 켜졌다"(4001)며 끊어 버렸다. 가장 최근에 붙은 열린 소켓 하나만 살린다.
    const devices: Array<{ ws: WebSocket; meta: Extract<ConnMeta, { role: 'device' }> & { id: string } }> = [];
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as (ConnMeta & { id: string }) | null;
      if (!meta) continue;
      if (meta.role === 'device') devices.push({ ws, meta });
      else this.core.attachVisitor(this.wrap(ws, meta.id), meta.ip, meta.sessionId);
    }
    devices.sort((a, b) => b.meta.connectedAt - a.meta.connectedAt);
    const live = devices.find((d) => d.ws.readyState === 1) ?? null;
    for (const d of devices) {
      if (d === live) {
        this.core.attachDevice(this.wrap(d.ws, d.meta.id), { engine: d.meta.engine, connectedAt: d.meta.connectedAt, hello: d.meta.hello });
        continue;
      }
      try {
        d.ws.serializeAttachment(null);
        d.ws.close(4004, 'stale');
      } catch {
        /* 이미 닫힘 */
      }
    }
  }

  private wrap(ws: WebSocket, id: string): Conn {
    const conn: Conn = {
      id,
      send: (data) => ws.send(data),
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          /* 이미 닫힘 */
        }
      },
      persist: (meta) => ws.serializeAttachment({ ...meta, id }),
      retire: () => {
        try {
          ws.serializeAttachment(null);
        } catch {
          /* 이미 닫힘 */
        }
      },
    };
    this.conns.set(ws, conn);
    return conn;
  }

  private json(req: Request, body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...corsHeaders(req, this.env) } });
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    const isUpgrade = req.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (url.pathname === '/health' && req.method === 'GET') return this.json(req, this.core.health());

    if (url.pathname === '/device/status' && req.method === 'GET') {
      if (!(await tokenMatches(bearer(req), this.env.DEVICE_TOKEN))) return this.json(req, { error: 'unauthorized' }, 401);
      return this.json(req, this.core.adminStatus());
    }

    if (url.pathname === '/device/connect') {
      if (!isUpgrade) return this.json(req, { error: 'upgrade_required' }, 426);
      if (!this.env.DEVICE_TOKEN) return this.json(req, { error: 'device_token_not_configured' }, 503);
      if (!(await tokenMatches(bearer(req), this.env.DEVICE_TOKEN))) return this.json(req, { error: 'unauthorized' }, 401);
      const pair = new WebSocketPair();
      const id = `d${++this.seq}-${crypto.randomUUID()}`;
      this.ctx.acceptWebSocket(pair[1], ['device']);
      const conn = this.wrap(pair[1], id);
      this.core.attachDevice(conn);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/v1/chat') {
      if (!originAllowed(req, this.env)) return this.json(req, { error: 'origin_not_allowed' }, 403);
      if (isUpgrade) {
        if (!this.core.canAcceptVisitor()) return this.json(req, { error: 'too_many_connections' }, 503);
        const pair = new WebSocketPair();
        const id = `v${++this.seq}-${crypto.randomUUID()}`;
        this.ctx.acceptWebSocket(pair[1], ['visitor']);
        const conn = this.wrap(pair[1], id);
        conn.persist?.({ role: 'visitor', sessionId: null, ip });
        this.core.attachVisitor(conn, ip);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (req.method === 'POST') {
        const body = await req.text();
        if (body.length > LIMITS.maxFrameBytes) return this.json(req, { error: 'too_large' }, 413);
        const r = await this.core.submitHttp(body, ip);
        if (r.type === 'bad_request') return this.json(req, r, 400);
        if (r.type === 'chat.error') {
          const status = r.code === 'offline' || r.code === 'device_disconnected' ? 503 : r.code === 'rate_limited' || r.code === 'budget_exhausted' ? 429 : r.code === 'timeout' ? 504 : 409;
          return this.json(req, r, status);
        }
        return this.json(req, r);
      }
      return this.json(req, { error: 'method_not_allowed' }, 405);
    }

    return this.json(req, { error: 'not_found' }, 404);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (typeof message !== 'string') {
      conn.close(1003, 'text_only');
      this.core.detach(conn.id);
      this.conns.delete(ws);
      return;
    }
    try {
      this.core.onMessage(conn.id, message);
    } catch (e) {
      // 프레임 하나를 처리하다 난 오류로 방 전체가 멈추면 안 된다. 그 프레임만 버린다.
      console.error('onMessage error', e);
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    const conn = this.conns.get(ws);
    if (conn) {
      this.conns.delete(ws);
      try {
        this.core.detach(conn.id);
      } catch (e) {
        console.error('detach error', e);
      }
    }
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {
      /* 이미 닫힘 */
    }
  }

  override webSocketError(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (conn) {
      this.conns.delete(ws);
      try {
        this.core.detach(conn.id);
      } catch (e) {
        console.error('detach error', e);
      }
    }
  }
}
