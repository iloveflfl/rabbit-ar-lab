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
  text: string;
  h: AskHandlers;
  timer: ReturnType<typeof setTimeout>;
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
      ws.send(JSON.stringify({ type: 'hello', sessionId: this.sessionId, clientVersion: CLIENT_VERSION }));
      this.pingTimer = setInterval(() => ws.readyState === ws.OPEN && ws.send('{"type":"ping"}'), 25_000);
    };
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      this.setStatus('offline');
      if (this.pending && !this.pending.done) this.fallback(this.pending, 'device_disconnected');
      this.scheduleReconnect();
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
        break;
      case 'chat.delta':
        if (p.text.length < LIMITS.maxReplyChars) {
          p.text += m.text;
          p.h.onDelta(p.text);
        }
        break;
      case 'chat.final':
        this.finish(p, toAnswer(m));
        break;
      case 'chat.error':
        this.fallback(p, m.code);
        break;
    }
  }

  private finish(p: Pending, a: Answer): void {
    if (p.done) return;
    p.done = true;
    clearTimeout(p.timer);
    if (this.pending === p) this.pending = null;
    p.h.onFinal(a);
  }

  /** 서버가 답하지 못할 때: 사전제작 답변을 타이핑하듯 보여 준다. */
  private async fallback(p: Pending, reason: Answer['fallbackReason']): Promise<void> {
    if (p.done) return;
    p.done = true;
    clearTimeout(p.timer);
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
    const p: Pending = { requestId: newUuid(), message, topic, text: '', h, done: false, timer: setTimeout(() => this.fallback(p, 'timeout'), LIMITS.requestTimeoutMs + 5000) };
    this.pending = p;
    const ws = this.ws;
    if (!this.relayUrl) {
      void sleep(350).then(() => this.fallback(p, 'unconfigured'));
    } else if (!ws || ws.readyState !== ws.OPEN || this.status === 'offline' || this.status === 'connecting') {
      void sleep(350).then(() => this.fallback(p, 'offline'));
    } else {
      const frame: Record<string, unknown> = { type: 'chat.request', requestId: p.requestId, sessionId: this.sessionId, topic, message, clientVersion: CLIENT_VERSION };
      if (selectedGraphId) frame.selectedGraphId = selectedGraphId;
      ws.send(JSON.stringify(frame));
    }
    return true;
  }

  cancel(): void {
    const p = this.pending;
    if (!p || p.done) return;
    p.done = true;
    clearTimeout(p.timer);
    this.pending = null;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel', requestId: p.requestId, sessionId: this.sessionId }));
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close(1000, 'bye');
  }
}

function toAnswer(m: ChatFinal): Answer {
  return { reply: m.reply, animation: m.animation, highlight: m.highlight, sourceFactIds: m.sourceFactIds, engine: m.engine, fallbackReason: null };
}
