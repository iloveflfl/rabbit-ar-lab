import {
  type Engine,
  type ErrorCode,
  type FactId,
  type HighlightId,
  type SceneAction,
  type ServerStatus,
  type TopicId,
  LIMITS,
  isEngine,
  isErrorCode,
  isFactId,
  isHighlightId,
  isSceneAction,
  isServerStatus,
  isTopicId,
  isUuid,
} from './ids';

/* ───────────── 관람객 → 릴레이 ───────────── */

export interface VisitorHello {
  type: 'hello';
  sessionId: string;
  clientVersion: string;
}
export interface ChatRequest {
  type: 'chat.request';
  requestId: string;
  sessionId: string;
  topic: TopicId;
  message: string;
  clientVersion: string;
  selectedGraphId?: HighlightId;
}
export interface CancelMessage {
  type: 'cancel';
  requestId: string;
  sessionId: string;
}
export interface Ping {
  type: 'ping';
}
export type VisitorMessage = VisitorHello | ChatRequest | CancelMessage | Ping;

/* ───────────── 릴레이 → 단말 ───────────── */

/** 릴레이가 단말로 넘길 때는 서버 시각을 붙인다. */
export interface DeviceChatRequest extends ChatRequest {
  timestamp: number;
}

/* ───────────── 단말 → 릴레이 ───────────── */

export interface DeviceHello {
  type: 'hello';
  protocol: number;
  deviceVersion: string;
  engine: Engine;
}
export interface DeviceStatus {
  type: 'status';
  status: 'online' | 'busy';
  engine: Engine;
}
export interface ChatDelta {
  type: 'chat.delta';
  requestId: string;
  sessionId: string;
  text: string;
}
export interface ChatFinal {
  type: 'chat.final';
  requestId: string;
  sessionId: string;
  reply: string;
  animation: SceneAction | null;
  highlight: HighlightId | null;
  sourceFactIds: FactId[];
  engine: Engine;
}
export interface ChatError {
  type: 'chat.error';
  requestId: string;
  sessionId: string;
  code: ErrorCode;
  message: string;
}
export interface Pong {
  type: 'pong';
}
export type DeviceMessage = DeviceHello | DeviceStatus | ChatDelta | ChatFinal | ChatError | Pong | Ping;

/* ───────────── 릴레이 → 관람객 ───────────── */

export interface HelloAck {
  type: 'hello.ack';
  status: ServerStatus;
  queueDepth: number;
}
export interface StatusEvent {
  type: 'status';
  status: ServerStatus;
}
export interface ChatQueued {
  type: 'chat.queued';
  requestId: string;
  sessionId: string;
  position: number;
}
export type ServerToVisitor = HelloAck | StatusEvent | ChatQueued | ChatDelta | ChatFinal | ChatError | Pong;

/** 공개 GET /health 응답. 하드웨어·모델 상세는 넣지 않는다. */
export interface HealthResponse {
  status: ServerStatus;
  version: string;
  connectedAt: number | null;
  queueDepth: number;
}

/* ───────────── 엄격한 검증기 ───────────── */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function parseJsonObject(raw: unknown): Parsed<Record<string, unknown>> {
  if (typeof raw !== 'string') return fail('frame_not_text');
  if (raw.length > LIMITS.maxFrameBytes) return fail('frame_too_large');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('invalid_json');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not_object');
  return { ok: true, value: data as Record<string, unknown> };
}

/** 허용한 키 외의 것이 있으면 거부한다. */
function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const k of Object.keys(o)) if (!keys.includes(k)) return false;
  return true;
}

const isShortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** 제어문자를 지우고 양끝 공백을 다듬는다. 줄바꿈과 탭은 공백으로 바꾼다. */
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\t\r\n]+/g, ' ').trim();
}

export function parseVisitorMessage(raw: unknown): Parsed<VisitorMessage> {
  const j = parseJsonObject(raw);
  if (!j.ok) return j;
  const o = j.value;
  switch (o.type) {
    case 'ping':
      return onlyKeys(o, ['type']) ? { ok: true, value: { type: 'ping' } } : fail('unknown_field');
    case 'hello': {
      if (!onlyKeys(o, ['type', 'sessionId', 'clientVersion'])) return fail('unknown_field');
      if (!isUuid(o.sessionId)) return fail('bad_session_id');
      if (!isShortString(o.clientVersion, 24)) return fail('bad_client_version');
      return { ok: true, value: { type: 'hello', sessionId: o.sessionId, clientVersion: o.clientVersion } };
    }
    case 'cancel': {
      if (!onlyKeys(o, ['type', 'requestId', 'sessionId'])) return fail('unknown_field');
      if (!isUuid(o.requestId)) return fail('bad_request_id');
      if (!isUuid(o.sessionId)) return fail('bad_session_id');
      return { ok: true, value: { type: 'cancel', requestId: o.requestId, sessionId: o.sessionId } };
    }
    case 'chat.request': {
      if (!onlyKeys(o, ['type', 'requestId', 'sessionId', 'topic', 'message', 'clientVersion', 'selectedGraphId']))
        return fail('unknown_field');
      if (!isUuid(o.requestId)) return fail('bad_request_id');
      if (!isUuid(o.sessionId)) return fail('bad_session_id');
      if (!isTopicId(o.topic)) return fail('bad_topic');
      if (!isShortString(o.clientVersion, 24)) return fail('bad_client_version');
      if (typeof o.message !== 'string') return fail('bad_message');
      const message = sanitizeText(o.message);
      if (message.length === 0) return fail('empty_message');
      if (message.length > LIMITS.maxMessageChars) return fail('message_too_long');
      const value: ChatRequest = {
        type: 'chat.request',
        requestId: o.requestId,
        sessionId: o.sessionId,
        topic: o.topic,
        message,
        clientVersion: o.clientVersion,
      };
      if (o.selectedGraphId !== undefined) {
        if (!isHighlightId(o.selectedGraphId)) return fail('bad_selected_graph');
        value.selectedGraphId = o.selectedGraphId;
      }
      return { ok: true, value };
    }
    default:
      return fail('unknown_type');
  }
}

function parseChatDelta(o: Record<string, unknown>): Parsed<ChatDelta> {
  if (!onlyKeys(o, ['type', 'requestId', 'sessionId', 'text'])) return fail('unknown_field');
  if (!isUuid(o.requestId)) return fail('bad_request_id');
  if (!isUuid(o.sessionId)) return fail('bad_session_id');
  if (typeof o.text !== 'string' || o.text.length === 0 || o.text.length > LIMITS.maxDeltaChars) return fail('bad_text');
  return { ok: true, value: { type: 'chat.delta', requestId: o.requestId, sessionId: o.sessionId, text: o.text } };
}

function parseChatFinal(o: Record<string, unknown>): Parsed<ChatFinal> {
  if (!onlyKeys(o, ['type', 'requestId', 'sessionId', 'reply', 'animation', 'highlight', 'sourceFactIds', 'engine']))
    return fail('unknown_field');
  if (!isUuid(o.requestId)) return fail('bad_request_id');
  if (!isUuid(o.sessionId)) return fail('bad_session_id');
  if (typeof o.reply !== 'string' || o.reply.trim().length === 0) return fail('bad_reply');
  if (!isEngine(o.engine)) return fail('bad_engine');
  // 동작·강조·근거는 allowlist 밖이면 "거부"가 아니라 "버림": 글 답변은 살리고 동작만 무시한다.
  const animation = isSceneAction(o.animation) ? o.animation : null;
  const highlight = isHighlightId(o.highlight) ? o.highlight : null;
  const sourceFactIds: FactId[] = [];
  if (Array.isArray(o.sourceFactIds)) {
    for (const f of o.sourceFactIds) {
      if (isFactId(f) && !sourceFactIds.includes(f) && sourceFactIds.length < LIMITS.maxSourceFacts) sourceFactIds.push(f);
    }
  }
  let reply = o.reply.trim();
  if (reply.length > LIMITS.maxReplyChars) reply = reply.slice(0, LIMITS.maxReplyChars - 1) + '…';
  return {
    ok: true,
    value: { type: 'chat.final', requestId: o.requestId, sessionId: o.sessionId, reply, animation, highlight, sourceFactIds, engine: o.engine },
  };
}

function parseChatError(o: Record<string, unknown>): Parsed<ChatError> {
  if (!onlyKeys(o, ['type', 'requestId', 'sessionId', 'code', 'message'])) return fail('unknown_field');
  if (!isUuid(o.requestId)) return fail('bad_request_id');
  if (!isUuid(o.sessionId)) return fail('bad_session_id');
  if (!isErrorCode(o.code)) return fail('bad_code');
  const message = typeof o.message === 'string' ? o.message.slice(0, 200) : '';
  return { ok: true, value: { type: 'chat.error', requestId: o.requestId, sessionId: o.sessionId, code: o.code, message } };
}

export function parseDeviceMessage(raw: unknown): Parsed<DeviceMessage> {
  const j = parseJsonObject(raw);
  if (!j.ok) return j;
  const o = j.value;
  switch (o.type) {
    case 'ping':
      return { ok: true, value: { type: 'ping' } };
    case 'pong':
      return { ok: true, value: { type: 'pong' } };
    case 'hello': {
      if (!onlyKeys(o, ['type', 'protocol', 'deviceVersion', 'engine'])) return fail('unknown_field');
      if (typeof o.protocol !== 'number' || !Number.isInteger(o.protocol)) return fail('bad_protocol');
      if (!isShortString(o.deviceVersion, 24)) return fail('bad_device_version');
      if (!isEngine(o.engine) || o.engine === 'canned') return fail('bad_engine');
      return { ok: true, value: { type: 'hello', protocol: o.protocol, deviceVersion: o.deviceVersion, engine: o.engine } };
    }
    case 'status': {
      if (!onlyKeys(o, ['type', 'status', 'engine'])) return fail('unknown_field');
      if (o.status !== 'online' && o.status !== 'busy') return fail('bad_status');
      if (!isEngine(o.engine)) return fail('bad_engine');
      return { ok: true, value: { type: 'status', status: o.status, engine: o.engine } };
    }
    case 'chat.delta':
      return parseChatDelta(o);
    case 'chat.final':
      return parseChatFinal(o);
    case 'chat.error':
      return parseChatError(o);
    default:
      return fail('unknown_type');
  }
}

/** 브라우저가 릴레이에서 받은 프레임을 검증한다. */
export function parseServerMessage(raw: unknown): Parsed<ServerToVisitor> {
  const j = parseJsonObject(raw);
  if (!j.ok) return j;
  const o = j.value;
  switch (o.type) {
    case 'pong':
      return { ok: true, value: { type: 'pong' } };
    case 'hello.ack': {
      if (!isServerStatus(o.status)) return fail('bad_status');
      const queueDepth = typeof o.queueDepth === 'number' && o.queueDepth >= 0 ? Math.floor(o.queueDepth) : 0;
      return { ok: true, value: { type: 'hello.ack', status: o.status, queueDepth } };
    }
    case 'status':
      if (!isServerStatus(o.status)) return fail('bad_status');
      return { ok: true, value: { type: 'status', status: o.status } };
    case 'chat.queued': {
      if (!isUuid(o.requestId) || !isUuid(o.sessionId)) return fail('bad_id');
      const position = typeof o.position === 'number' && o.position >= 0 ? Math.floor(o.position) : 0;
      return { ok: true, value: { type: 'chat.queued', requestId: o.requestId, sessionId: o.sessionId, position } };
    }
    case 'chat.delta':
      return parseChatDelta(o);
    case 'chat.final':
      return parseChatFinal(o);
    case 'chat.error':
      return parseChatError(o);
    default:
      return fail('unknown_type');
  }
}

export function newUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
