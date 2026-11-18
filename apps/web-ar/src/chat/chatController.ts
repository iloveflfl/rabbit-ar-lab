/**
 * 채팅 두뇌: 릴레이(WSS)로 전시자 폰의 로컬 LLM 에 묻고, 안 되면 사전제작 답변으로 넘어간다.
 *
 * - 세션 ID 는 탭마다 새로 만든 임시 UUID. 다른 관람객과 섞이지 않는다.
 * - 이 코드에는 비밀값이 없다. 릴레이 주소는 공개 정보다.
 * - 받은 프레임은 parseServerMessage 로 검증하고, 내가 보낸 requestId 가 아니면 버린다.
 */
import { CLIENT_VERSION, type ChatFinal, type Engine, type ErrorCode, type FactId, type HighlightId, type SceneAction, type ServerStatus, type TopicId, LIMITS, newUuid, parseServerMessage, sanitizeText } from '@rabbit/shared';
import { matchCanned } from '@rabbit/content';

export type LinkStatus = ServerStatus | 'unconfigured' | 'connecting';

export interface Answer {
  reply: string;
  animation: SceneAction | null;
  highlight: HighlightId | null;
  sourceFactIds: FactId[];
  engine: Engine;
  /** 사전제작 답변으로 넘어간 이유 */
  fallbackReason: ErrorCode | 'unconfigured' | null;
}

export interface AskHandlers {
  onQueued?(position: number): void;
  onDelta(textSoFar: string): void;
  onFinal(answer: Answer): void;
}

interface Pending {
  requestId: string;
  message: string;
  topic: TopicId;
  selectedGraphId: HighlightId | null;
  /** 연결이 끊겨서 다시 보낸 횟수 */
  attempts: number;
  text: string;
  h: AskHandlers;
  timer: ReturnType<typeof setTimeout>;
  /** 서버가 아무 소식도 없이 멈춘 것을 잡는 타이머 */
  stall: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChatController {
  readonly sessionId = newUuid();
  private ws: WebSocket | null = null;
  private status: LinkStatus;
  private pending: Pending | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private lastFrameAt = 0;
  /** 화면으로 돌아오거나 네트워크가 돌아오면 기다리지 않고 바로 다시 붙는다. */
  private readonly wake = () => {
    if (document.visibilityState === 'visible') this.reconnectNow();
  };
  onStatus: ((s: LinkStatus) => void) | null = null;

  /** relayUrl: 예) https://rabbit-ar-relay.example.workers.dev  (없으면 사전제작 답변만 쓴다) */
  constructor(private readonly relayUrl: string | null) {
    this.status = relayUrl ? 'connecting' : 'unconfigured';
  }

  get linkStatus(): LinkStatus {
    return this.status;
  }
  get busy(): boolean {
    return this.pending !== null;
  }

  private setStatus(s: LinkStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus?.(s);
  }

  connect(): void {
    if (!this.relayUrl || this.closed) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // 이미 붙어 있거나 붙는 중
    document.addEventListener('visibilitychange', this.wake);
    window.addEventListener('online', this.wake);
    const url = this.relayUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/v1/chat';
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.lastFrameAt = Date.now();
      ws.send(JSON.stringify({ type: 'hello', sessionId: this.sessionId, clientVersion: CLIENT_VERSION }));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        // 폰이 잠들었다 깨면 소켓이 죽었는데도 열린 것처럼 보일 수 있다. 응답이 오래 없으면 끊고 다시 붙는다.
        if (Date.now() - this.lastFrameAt > 65_000) return ws.close();
        ws.send('{"type":"ping"}');
      }, 25_000);
    };
    ws.onmessage = (ev) => {
      this.lastFrameAt = Date.now();
      this.onFrame(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // 이미 새 소켓으로 바뀌었다
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.ws = null;
      this.setStatus(this.closed ? 'offline' : 'connecting');
      this.scheduleReconnect();
      if (this.pending && !this.pending.done) void this.retryOrFallback(this.pending, 'device_disconnected');
    };
    ws.onerror = () => {
      /* onclose 가 이어서 온다 */
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(30_000, 1500 * 2 ** this.retry++) * (0.7 + Math.random() * 0.6);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.closed || !this.relayUrl) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retry = 0;
    this.connect();
  }

  private ready(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && (this.status === 'online' || this.status === 'busy');
  }

  /** 질문을 릴레이로 보낸다. 연결이 잠깐 끊겼거나 서버가 막 다시 붙는 중이면 몇 초 기다렸다가 보낸다. */
  private async dispatch(p: Pending): Promise<void> {
    if (!this.ready()) {
      this.reconnectNow();
      const t0 = Date.now();
      while (!p.done && !this.ready() && Date.now() - t0 < 6000) await sleep(150);
    }
    if (p.done) return;
    p.requestId = newUuid(); // 다시 보낼 때는 새 번호 (릴레이가 같은 번호를 거절한다)
    p.text = '';
    const frame: Record<string, unknown> = { type: 'chat.request', requestId: p.requestId, sessionId: this.sessionId, topic: p.topic, message: p.message, clientVersion: CLIENT_VERSION };
    if (p.selectedGraphId) frame.selectedGraphId = p.selectedGraphId;
    if (!this.ready()) {
      // 웹소켓을 막는 네트워크(일부 공용 Wi-Fi)일 수 있다. 일반 HTTP 요청으로 한 번 물어본다.
      const wsDown = !this.ws || this.ws.readyState !== WebSocket.OPEN;
      if (wsDown && (await this.askHttp(p, frame))) return;
      if (!p.done) void this.fallback(p, 'offline');
      return;
    }
    try {
      this.ws!.send(JSON.stringify(frame));
      this.watch(p, 80_000);
    } catch {
      void this.retryOrFallback(p, 'device_disconnected');
    }
  }

  /** 웹소켓 없이 묻는다 (스트리밍 없이 완성된 답만 받는다). 처리했으면 true. */
  private async askHttp(p: Pending, frame: Record<string, unknown>): Promise<boolean> {
    const base = this.relayUrl!.replace(/^ws/, 'http').replace(/\/$/, '');
    try {
      const health = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(6000) })).json()) as { status?: string };
      if (health.status !== 'online' && health.status !== 'busy') return false;
      if (p.done) return true;
      this.watch(p, LIMITS.requestTimeoutMs + 10_000);
      // text/plain 으로 보내면 사전 요청(preflight) 없이 바로 간다.
      const res = await fetch(`${base}/v1/chat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(frame), signal: AbortSignal.timeout(LIMITS.requestTimeoutMs + 10_000) });
      const parsed = parseServerMessage(await res.text());
      if (p.done) return true;
      if (!parsed.ok) return false;
      const m = parsed.value;
      if (m.type === 'chat.final') {
        this.finish(p, toAnswer(m));
        return true;
      }
      if (m.type === 'chat.error') {
        void this.fallback(p, m.code);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 연결 문제로 실패했으면 한 번은 조용히 다시 보낸다 (쓰던 답은 새 답으로 덮어쓴다). */
  private async retryOrFallback(p: Pending, reason: ErrorCode): Promise<void> {
    const transient = reason === 'device_disconnected' || reason === 'offline';
    if (!transient || p.attempts >= 1) return void this.fallback(p, reason);
    p.attempts++;
    p.requestId = ''; // 이전 요청의 늦은 프레임은 버린다
    if (p.stall) clearTimeout(p.stall);
    p.stall = null;
    await sleep(1200);
    if (!p.done) await this.dispatch(p);
  }

  private onFrame(raw: unknown): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) return;
    const m = parsed.value;
    if (m.type === 'hello.ack' || m.type === 'status') return this.setStatus(m.status);
    if (m.type === 'pong') return;
    const p = this.pending;
    // 내가 보낸 요청의 답이 아니면 버린다.
    if (!p || p.done || m.requestId !== p.requestId || m.sessionId !== this.sessionId) return;
    switch (m.type) {
      case 'chat.queued':
        p.h.onQueued?.(m.position);
        // 앞에 줄 선 질문이 있으면 그만큼 더 기다려 준다.
        this.watch(p, Math.min(LIMITS.requestTimeoutMs, 80_000 + Math.max(0, m.position - 1) * 60_000));
        break;
      case 'chat.delta':
        this.watch(p, 60_000);
        if (p.text.length < LIMITS.maxReplyChars) {
          p.text += m.text;
          p.h.onDelta(p.text);
        }
        break;
      case 'chat.final':
        this.finish(p, toAnswer(m));
        break;
      case 'chat.error':
        void this.retryOrFallback(p, m.code);
        break;
    }
  }

  /** 일정 시간 동안 이 질문에 대한 소식이 없으면 준비된 답변으로 넘어간다. 소식이 올 때마다 다시 건다. */
  private watch(p: Pending, ms: number): void {
    if (p.stall) clearTimeout(p.stall);
    p.stall = p.done ? null : setTimeout(() => void this.fallback(p, 'timeout'), ms);
  }

  private settle(p: Pending): void {
    p.done = true;
    clearTimeout(p.timer);
    if (p.stall) clearTimeout(p.stall);
    p.stall = null;
  }

  private finish(p: Pending, a: Answer): void {
    if (p.done) return;
    this.settle(p);
    if (this.pending === p) this.pending = null;
    p.h.onFinal(a);
  }

  /** 서버가 답하지 못할 때: 사전제작 답변을 타이핑하듯 보여 준다. */
  private async fallback(p: Pending, reason: Answer['fallbackReason']): Promise<void> {
    if (p.done) return;
    this.settle(p);
    const a = matchCanned(p.message, p.topic);
    let shown = '';
    for (let i = 0; i < a.reply.length; i += 3) {
      shown = a.reply.slice(0, i + 3);
      p.h.onDelta(shown);
      await sleep(22);
    }
    if (this.pending === p) this.pending = null;
    p.h.onFinal({ reply: a.reply, animation: a.animation, highlight: a.highlight, sourceFactIds: a.sourceFactIds, engine: 'canned', fallbackReason: reason });
  }

  /** 질문을 보낸다. 한 번에 하나만. 반환값이 false 면 앞 질문이 아직 진행 중이다. */
  ask(rawMessage: string, topic: TopicId, selectedGraphId: HighlightId | null, h: AskHandlers): boolean {
    if (this.pending) return false;
    const message = sanitizeText(rawMessage).slice(0, LIMITS.maxMessageChars);
    if (!message) return false;
    const p: Pending = { requestId: '', message, topic, selectedGraphId, attempts: 0, text: '', h, done: false, stall: null, timer: setTimeout(() => this.fallback(p, 'timeout'), LIMITS.requestTimeoutMs + 12_000) };
    this.pending = p;
    if (!this.relayUrl) void sleep(350).then(() => this.fallback(p, 'unconfigured'));
    else void this.dispatch(p);
    return true;
  }

  cancel(): void {
    const p = this.pending;
    if (!p || p.done) return;
    this.settle(p);
    this.pending = null;
    if (p.requestId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel', requestId: p.requestId, sessionId: this.sessionId }));
  }

  close(): void {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.wake);
    window.removeEventListener('online', this.wake);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close(1000, 'bye');
  }
}

function toAnswer(m: ChatFinal): Answer {
  return { reply: m.reply, animation: m.animation, highlight: m.highlight, sourceFactIds: m.sourceFactIds, engine: m.engine, fallbackReason: null };
}
