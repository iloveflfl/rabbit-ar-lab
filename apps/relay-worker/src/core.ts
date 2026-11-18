/**
 * 릴레이의 순수 로직. Cloudflare 런타임에 의존하지 않으므로 vitest 로 그대로 검증한다.
 * 이 코드는 메시지를 "전달"만 한다. 추론은 전부 전시자의 스마트폰에서 일어난다.
 */
import {
  type ChatError,
  type ChatFinal,
  type ChatRequest,
  type DeviceChatRequest,
  type Engine,
  type ErrorCode,
  type HealthResponse,
  type ServerStatus,
  type ServerToVisitor,
  LIMITS,
  parseDeviceMessage,
  parseVisitorMessage,
} from '@rabbit/shared';

export interface Conn {
  readonly id: string;
  send(data: string): void;
  close(code: number, reason: string): void;
  /** 휴면(hibernation) 뒤에도 살아남아야 하는 최소 정보를 소켓에 붙여 둔다. */
  persist?(meta: ConnMeta): void;
}

export type ConnMeta =
  | { role: 'device'; engine: Engine; connectedAt: number; hello: boolean }
  | { role: 'visitor'; sessionId: string | null; ip: string };

export interface Budget {
  day: string;
  used: number;
}

export interface CoreDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  version: string;
  limits?: Partial<Record<keyof typeof LIMITS, number>>;
  onBudgetChange?(b: Budget): void;
}

interface Visitor {
  conn: Conn;
  sessionId: string | null;
  ip: string;
}
interface Pending {
  requestId: string;
  sessionId: string;
  connId: string;
  timer: unknown;
  startedAt: number;
  deltaChars: number;
}

const SEEN_TTL_MS = 10 * 60_000;
const SEEN_MAX = 5000;

export class RelayCore {
  private readonly lim: Record<keyof typeof LIMITS, number>;
  private device: { conn: Conn; engine: Engine; connectedAt: number; hello: boolean; busy: boolean } | null = null;
  private readonly visitors = new Map<string, Visitor>();
  private readonly sessions = new Map<string, string>(); // sessionId → connId
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<string, number>(); // requestId → 처음 본 시각 (재사용 방지)
  private readonly rate = new Map<string, number[]>();
  private budget: Budget = { day: '', used: 0 };

  constructor(private readonly deps: CoreDeps) {
    this.lim = { ...LIMITS, ...(deps.limits ?? {}) };
  }

  /* ───── 연결 수명 ───── */

  loadBudget(b: Budget | null | undefined): void {
    if (b && typeof b.day === 'string' && typeof b.used === 'number') this.budget = { ...b };
  }

  /** 인증을 통과한 단말 소켓만 넘겨야 한다. 이전 단말 연결이 있으면 새 연결로 바꾼다. */
  attachDevice(conn: Conn, restored?: { engine: Engine; connectedAt: number; hello: boolean }): void {
    if (this.device && this.device.conn.id !== conn.id) {
      const old = this.device.conn;
      this.device = null;
      // 이전 단말이 만들던 답은 이제 올 수 없다. 바로 실패를 알려야 관람객이 시간 초과까지 기다리지 않는다.
      for (const p of [...this.pending.values()]) this.failPending(p, 'device_disconnected', '토끼 서버 연결이 끊어졌어요.');
      try {
        old.close(4001, 'replaced');
      } catch {
        /* 이미 닫힘 */
      }
    }
    this.device = {
      conn,
      engine: restored?.engine ?? 'mock',
      connectedAt: restored?.connectedAt ?? this.deps.now(),
      hello: restored?.hello ?? false,
      busy: false,
    };
    this.persistDevice();
    if (restored?.hello) return; // 휴면에서 깨어난 것뿐이므로 방송하지 않는다.
  }

  canAcceptVisitor(): boolean {
    return this.visitors.size < this.lim.maxVisitorSockets;
  }

  attachVisitor(conn: Conn, ip: string, restoredSessionId: string | null = null): void {
    this.visitors.set(conn.id, { conn, sessionId: restoredSessionId, ip });
    if (restoredSessionId) this.sessions.set(restoredSessionId, conn.id);
  }

  detach(connId: string): void {
    if (this.device && this.device.conn.id === connId) {
      this.device = null;
      for (const p of [...this.pending.values()]) this.failPending(p, 'device_disconnected', '토끼 서버 연결이 끊어졌어요.');
      this.broadcastStatus();
      return;
    }
    const v = this.visitors.get(connId);
    if (!v) return;
    this.visitors.delete(connId);
    if (v.sessionId && this.sessions.get(v.sessionId) === connId) this.sessions.delete(v.sessionId);
    for (const p of [...this.pending.values()]) {
      if (p.connId === connId) {
        this.dropPending(p);
        this.sendDevice({ type: 'cancel', requestId: p.requestId, sessionId: p.sessionId });
      }
    }
  }

  /* ───── 상태 ───── */

  status(): ServerStatus {
    if (!this.device || !this.device.hello) return 'offline';
    if (this.device.busy || this.pending.size >= this.lim.maxQueueDepth) return 'busy';
    return 'online';
  }

  health(): HealthResponse {
    return {
      status: this.status(),
      version: this.deps.version,
      connectedAt: this.device && this.device.hello ? this.device.connectedAt : null,
      queueDepth: this.pending.size,
    };
  }

  /** 소유자 전용 상세 상태. 공개 /health 와 분리한다. */
  adminStatus() {
    this.rollBudgetDay();
    return {
      ...this.health(),
      engine: this.device?.engine ?? null,
      visitors: this.visitors.size,
      sessions: this.sessions.size,
      budgetDay: this.budget.day,
      budgetUsed: this.budget.used,
      budgetLimit: this.lim.dailyBudget,
    };
  }

  /* ───── 메시지 처리 ───── */

  onMessage(connId: string, raw: unknown): void {
    if (this.device && this.device.conn.id === connId) return this.onDeviceMessage(raw);
    const v = this.visitors.get(connId);
    if (v) this.onVisitorMessage(v, raw);
  }

  private onVisitorMessage(v: Visitor, raw: unknown): void {
    const parsed = parseVisitorMessage(raw);
    if (!parsed.ok) {
      // 스키마를 어긴 프레임은 조용히 넘기지 않고 연결을 끊는다.
      v.conn.close(1008, parsed.error);
      this.detach(v.conn.id);
      return;
    }
    const m = parsed.value;
    switch (m.type) {
      case 'ping':
        this.sendTo(v.conn, { type: 'pong' });
        return;
      case 'hello': {
        const existing = this.sessions.get(m.sessionId);
        if (existing && existing !== v.conn.id) {
          // 같은 세션의 재접속: 예전 소켓을 정리하고 새 소켓으로 잇는다.
          const old = this.visitors.get(existing);
          if (old) {
            old.sessionId = null;
            try {
              old.conn.close(4002, 'session_resumed');
            } catch {
              /* 이미 닫힘 */
            }
            this.visitors.delete(existing);
          }
        }
        if (v.sessionId && v.sessionId !== m.sessionId) this.sessions.delete(v.sessionId);
        v.sessionId = m.sessionId;
        this.sessions.set(m.sessionId, v.conn.id);
        v.conn.persist?.({ role: 'visitor', sessionId: v.sessionId, ip: v.ip });
        this.sendTo(v.conn, { type: 'hello.ack', status: this.status(), queueDepth: this.pending.size });
        return;
      }
      case 'cancel': {
        const p = this.pending.get(m.requestId);
        if (p && p.connId === v.conn.id && p.sessionId === m.sessionId) {
          this.dropPending(p);
          this.sendDevice({ type: 'cancel', requestId: p.requestId, sessionId: p.sessionId });
        }
        return;
      }
      case 'chat.request':
        this.acceptRequest(v, m);
        return;
    }
  }

  private acceptRequest(v: Visitor, m: ChatRequest): void {
    const reject = (code: ErrorCode, message: string) =>
      this.sendTo(v.conn, { type: 'chat.error', requestId: m.requestId, sessionId: m.sessionId, code, message });

    if (!v.sessionId || v.sessionId !== m.sessionId) return reject('bad_request', 'hello 를 먼저 보내야 해요.');

    const now = this.deps.now();
    this.pruneSeen(now);
    if (this.seen.has(m.requestId)) return reject('duplicate_request', '이미 처리한 요청이에요.');
    this.seen.set(m.requestId, now);

    let mine = 0;
    for (const p of this.pending.values()) if (p.sessionId === m.sessionId) mine++;
    if (mine >= this.lim.maxPendingPerSession) return reject('busy', '앞 질문에 답하는 중이에요.');

    if (!this.allow(`s:${m.sessionId}`, this.lim.sessionPerMinute, now) || !this.allow(`ip:${v.ip}`, this.lim.ipPerMinute, now))
      return reject('rate_limited', '질문이 너무 빨라요. 잠깐 뒤에 다시 물어봐 주세요.');

    if (!this.device || !this.device.hello) return reject('offline', '토끼 서버가 꺼져 있어요.');
    if (this.pending.size >= this.lim.maxQueueDepth) return reject('busy', '줄이 꽉 찼어요. 잠깐 뒤에 다시 물어봐 주세요.');

    this.rollBudgetDay();
    if (this.budget.used >= this.lim.dailyBudget) return reject('budget_exhausted', '오늘 준비한 답변 횟수를 다 썼어요.');
    this.budget.used++;
    this.deps.onBudgetChange?.({ ...this.budget });

    const p: Pending = {
      requestId: m.requestId,
      sessionId: m.sessionId,
      connId: v.conn.id,
      startedAt: now,
      deltaChars: 0,
      timer: this.deps.setTimer(() => {
        const cur = this.pending.get(m.requestId);
        if (!cur) return;
        this.sendDevice({ type: 'cancel', requestId: cur.requestId, sessionId: cur.sessionId });
        this.failPending(cur, 'timeout', '답변이 너무 오래 걸렸어요.');
      }, this.lim.requestTimeoutMs),
    };
    this.pending.set(m.requestId, p);

    const out: DeviceChatRequest = { ...m, timestamp: now };
    this.sendDevice(out);
    this.sendTo(v.conn, { type: 'chat.queued', requestId: m.requestId, sessionId: m.sessionId, position: this.pending.size });
  }

  private onDeviceMessage(raw: unknown): void {
    const parsed = parseDeviceMessage(raw);
    if (!parsed.ok || !this.device) return; // 단말의 잘못된 프레임은 버린다(연결은 유지).
    const m = parsed.value;
    switch (m.type) {
      case 'ping':
        this.sendDevice({ type: 'pong' });
        return;
      case 'pong':
        return;
      case 'hello': {
        const first = !this.device.hello;
        this.device.hello = true;
        this.device.engine = m.engine;
        this.persistDevice();
        this.sendDevice({ type: 'hello.ack', status: 'online', queueDepth: this.pending.size });
        if (first) this.broadcastStatus();
        return;
      }
      case 'status': {
        const before = this.status();
        this.device.busy = m.status === 'busy';
        this.device.engine = m.engine;
        this.persistDevice();
        if (before !== this.status()) this.broadcastStatus();
        return;
      }
      case 'chat.delta': {
        const target = this.routeFor(m.requestId, m.sessionId);
        if (!target) return;
        const p = this.pending.get(m.requestId);
        if (p) {
          p.deltaChars += m.text.length;
          if (p.deltaChars > this.lim.maxReplyChars * 2) return; // 폭주하는 스트림은 잘라 낸다.
        }
        this.sendTo(target, m);
        return;
      }
      case 'chat.final':
      case 'chat.error': {
        const target = this.routeFor(m.requestId, m.sessionId);
        const p = this.pending.get(m.requestId);
        if (p) this.dropPending(p);
        if (target) this.sendTo(target, m);
        return;
      }
    }
  }

  /**
   * 응답을 돌려보낼 관람객 소켓을 찾는다.
   * requestId 로 먼저 찾고(다른 세션으로 새지 않게 sessionId 도 대조),
   * 휴면으로 pending 을 잃었으면 sessionId 로 찾는다.
   */
  private routeFor(requestId: string, sessionId: string): Conn | null {
    const p = this.pending.get(requestId);
    if (p) {
      if (p.sessionId !== sessionId) return null;
      return this.visitors.get(p.connId)?.conn ?? null;
    }
    if (this.seen.has(requestId)) return null; // 이미 끝났거나 시간 초과된 요청
    const connId = this.sessions.get(sessionId);
    return connId ? (this.visitors.get(connId)?.conn ?? null) : null;
  }

  /* ───── HTTP POST /v1/chat (스트리밍 없는 단발 요청) ───── */

  submitHttp(raw: string, ip: string): Promise<ChatFinal | ChatError | { type: 'bad_request'; error: string }> {
    const parsed = parseVisitorMessage(raw);
    if (!parsed.ok) return Promise.resolve({ type: 'bad_request', error: parsed.error });
    if (parsed.value.type !== 'chat.request') return Promise.resolve({ type: 'bad_request', error: 'expected_chat_request' });
    const req = parsed.value;
    return new Promise((resolve) => {
      const id = `http:${req.requestId}`;
      const conn: Conn = {
        id,
        send: (data) => {
          const m = JSON.parse(data) as ServerToVisitor;
          if (m.type === 'chat.final' || m.type === 'chat.error') {
            this.visitors.delete(id);
            resolve(m);
          }
        },
        close: () => {
          this.visitors.delete(id);
        },
      };
      // HTTP 요청은 세션 표(sessions)에 올리지 않는다: 같은 세션의 WebSocket 을 밀어내지 않기 위해서다.
      const v: Visitor = { conn, sessionId: req.sessionId, ip };
      this.visitors.set(id, v);
      this.acceptRequest(v, req);
    });
  }

  /* ───── 내부 도우미 ───── */

  private persistDevice(): void {
    const d = this.device;
    if (d) d.conn.persist?.({ role: 'device', engine: d.engine, connectedAt: d.connectedAt, hello: d.hello });
  }

  private sendTo(conn: Conn, m: ServerToVisitor): void {
    try {
      conn.send(JSON.stringify(m));
    } catch {
      /* 닫힌 소켓 */
    }
  }

  private sendDevice(m: object): void {
    if (!this.device) return;
    try {
      this.device.conn.send(JSON.stringify(m));
    } catch {
      /* 닫힌 소켓 */
    }
  }

  private broadcastStatus(): void {
    const status = this.status();
    for (const v of this.visitors.values()) this.sendTo(v.conn, { type: 'status', status });
  }

  private dropPending(p: Pending): void {
    this.deps.clearTimer(p.timer);
    this.pending.delete(p.requestId);
  }

  private failPending(p: Pending, code: ErrorCode, message: string): void {
    this.dropPending(p);
    const v = this.visitors.get(p.connId);
    if (v) this.sendTo(v.conn, { type: 'chat.error', requestId: p.requestId, sessionId: p.sessionId, code, message });
  }

  private allow(key: string, perMinute: number, now: number): boolean {
    const list = (this.rate.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= perMinute) {
      this.rate.set(key, list);
      return false;
    }
    list.push(now);
    this.rate.set(key, list);
    if (this.rate.size > 4000) {
      for (const [k, ts] of this.rate) if (ts.every((t) => now - t >= 60_000)) this.rate.delete(k);
    }
    return true;
  }

  private pruneSeen(now: number): void {
    if (this.seen.size < SEEN_MAX / 2) return;
    for (const [id, t] of this.seen) if (now - t > SEEN_TTL_MS && !this.pending.has(id)) this.seen.delete(id);
    if (this.seen.size > SEEN_MAX) {
      const drop = this.seen.size - SEEN_MAX;
      let i = 0;
      for (const id of this.seen.keys()) {
        if (i++ >= drop) break;
        if (!this.pending.has(id)) this.seen.delete(id);
      }
    }
  }

  private rollBudgetDay(): void {
    const day = new Date(this.deps.now()).toISOString().slice(0, 10);
    if (this.budget.day !== day) {
      this.budget = { day, used: 0 };
      this.deps.onBudgetChange?.({ ...this.budget });
    }
  }
}
