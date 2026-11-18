import { beforeEach, describe, expect, it } from 'vitest';
import { newUuid } from '@rabbit/shared';
import { type Conn, RelayCore } from '../src/core';

class FakeConn implements Conn {
  sent: any[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly id: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  last(type?: string) {
    const list = type ? this.sent.filter((m) => m.type === type) : this.sent;
    return list[list.length - 1];
  }
}

let now = 1_700_000_000_000;
let timers: Array<{ fn: () => void; at: number; dead: boolean }> = [];
const advance = (ms: number) => {
  now += ms;
  for (const t of timers) if (!t.dead && t.at <= now) ((t.dead = true), t.fn());
};
const makeCore = (limits = {}) =>
  new RelayCore({
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { dead: boolean }).dead = true;
    },
    version: 'test',
    limits,
  });

function visitor(core: RelayCore, name: string, ip = '1.1.1.1') {
  const conn = new FakeConn(name);
  const sessionId = newUuid();
  core.attachVisitor(conn, ip);
  core.onMessage(name, JSON.stringify({ type: 'hello', sessionId, clientVersion: '1.0.0' }));
  const ask = (message = '왜 73도야?', requestId = newUuid()) => {
    core.onMessage(name, JSON.stringify({ type: 'chat.request', requestId, sessionId, topic: 'general', message, clientVersion: '1.0.0' }));
    return requestId;
  };
  return { conn, sessionId, ask };
}
function device(core: RelayCore, id = 'dev') {
  const conn = new FakeConn(id);
  core.attachDevice(conn);
  core.onMessage(id, JSON.stringify({ type: 'hello', protocol: 1, deviceVersion: '1.0.0', engine: 'mock' }));
  const final = (requestId: string, sessionId: string, reply = '답') =>
    core.onMessage(id, JSON.stringify({ type: 'chat.final', requestId, sessionId, reply, animation: 'show_heating', highlight: null, sourceFactIds: [], engine: 'mock' }));
  const delta = (requestId: string, sessionId: string, text: string) => core.onMessage(id, JSON.stringify({ type: 'chat.delta', requestId, sessionId, text }));
  return { conn, final, delta };
}

beforeEach(() => {
  now = 1_700_000_000_000;
  timers = [];
});

describe('RelayCore', () => {
  it('단말이 없으면 offline 으로 즉시 거절한다', () => {
    const core = makeCore();
    const a = visitor(core, 'a');
    expect(a.conn.last('hello.ack').status).toBe('offline');
    a.ask();
    expect(a.conn.last('chat.error').code).toBe('offline');
    expect(core.health().status).toBe('offline');
  });

  it('단말이 hello 를 보내기 전에는 온라인이 아니다', () => {
    const core = makeCore();
    core.attachDevice(new FakeConn('dev'));
    expect(core.health().status).toBe('offline');
    const a = visitor(core, 'a');
    a.ask();
    expect(a.conn.last('chat.error').code).toBe('offline');
  });

  it('두 관람객의 답변이 섞이지 않는다', () => {
    const core = makeCore();
    const d = device(core);
    const a = visitor(core, 'a', '1.1.1.1');
    const b = visitor(core, 'b', '2.2.2.2');
    const ra = a.ask('A 질문');
    const rb = b.ask('B 질문');
    const forwarded = d.conn.sent.filter((m) => m.type === 'chat.request');
    expect(forwarded.map((m) => m.message)).toEqual(['A 질문', 'B 질문']);
    expect(forwarded[0].timestamp).toBe(now);

    d.delta(rb, b.sessionId, 'B-조각');
    d.final(rb, b.sessionId, 'B 답');
    d.final(ra, a.sessionId, 'A 답');
    expect(a.conn.sent.filter((m) => m.type === 'chat.delta')).toEqual([]);
    expect(a.conn.last('chat.final').reply).toBe('A 답');
    expect(b.conn.last('chat.delta').text).toBe('B-조각');
    expect(b.conn.last('chat.final').reply).toBe('B 답');
    expect(b.conn.last('chat.final').requestId).toBe(rb);
  });

  it('requestId 와 sessionId 가 어긋난 단말 응답은 전달하지 않는다', () => {
    const core = makeCore();
    const d = device(core);
    const a = visitor(core, 'a');
    const b = visitor(core, 'b', '2.2.2.2');
    const ra = a.ask();
    d.final(ra, b.sessionId, '잘못된 배달');
    expect(a.conn.last('chat.final')).toBeUndefined();
    expect(b.conn.last('chat.final')).toBeUndefined();
  });

  it('requestId 재사용을 막는다', () => {
    const core = makeCore();
    const d = device(core);
    const a = visitor(core, 'a');
    const r = a.ask();
    d.final(r, a.sessionId);
    a.ask('다시', r);
    expect(a.conn.last('chat.error').code).toBe('duplicate_request');
    expect(d.conn.sent.filter((m) => m.type === 'chat.request')).toHaveLength(1);
  });

  it('세션당 동시에 한 질문만 받는다', () => {
    const core = makeCore();
    device(core);
    const a = visitor(core, 'a');
    a.ask();
    a.ask();
    expect(a.conn.last('chat.error').code).toBe('busy');
  });

  it('hello 없이 보낸 요청, 남의 세션으로 보낸 요청은 거절한다', () => {
    const core = makeCore();
    device(core);
    const conn = new FakeConn('x');
    core.attachVisitor(conn, '9.9.9.9');
    const sid = newUuid();
    core.onMessage('x', JSON.stringify({ type: 'chat.request', requestId: newUuid(), sessionId: sid, topic: 'general', message: 'hi', clientVersion: '1' }));
    expect(conn.last('chat.error').code).toBe('bad_request');
  });

  it('세션 분당 한도를 넘으면 rate_limited', () => {
    const core = makeCore({ sessionPerMinute: 2 });
    const d = device(core);
    const a = visitor(core, 'a');
    for (let i = 0; i < 2; i++) d.final(a.ask(), a.sessionId);
    a.ask();
    expect(a.conn.last('chat.error').code).toBe('rate_limited');
    advance(61_000);
    const r = a.ask();
    expect(a.conn.last('chat.queued').requestId).toBe(r);
  });

  it('하루 예산을 넘으면 budget_exhausted, 날짜가 바뀌면 풀린다', () => {
    const core = makeCore({ dailyBudget: 1, sessionPerMinute: 99 });
    const d = device(core);
    const a = visitor(core, 'a');
    d.final(a.ask(), a.sessionId);
    a.ask();
    expect(a.conn.last('chat.error').code).toBe('budget_exhausted');
    advance(24 * 3600_000);
    const r = a.ask();
    expect(a.conn.last('chat.queued').requestId).toBe(r);
  });

  it('대기열이 가득 차면 busy', () => {
    const core = makeCore({ maxQueueDepth: 1 });
    device(core);
    const a = visitor(core, 'a', '1.1.1.1');
    const b = visitor(core, 'b', '2.2.2.2');
    a.ask();
    expect(core.health().status).toBe('busy');
    b.ask();
    expect(b.conn.last('chat.error').code).toBe('busy');
  });

  it('시간 초과: 관람객에게 timeout, 단말에 cancel, 늦은 답은 버린다', () => {
    const core = makeCore({ requestTimeoutMs: 1000 });
    const d = device(core);
    const a = visitor(core, 'a');
    const r = a.ask();
    advance(1001);
    expect(a.conn.last('chat.error').code).toBe('timeout');
    expect(d.conn.last('cancel').requestId).toBe(r);
    d.final(r, a.sessionId, '늦은 답');
    expect(a.conn.last('chat.final')).toBeUndefined();
  });

  it('단말이 끊기면 진행 중 요청을 실패시키고 offline 을 방송한다', () => {
    const core = makeCore();
    device(core);
    const a = visitor(core, 'a');
    const b = visitor(core, 'b', '2.2.2.2');
    a.ask();
    core.detach('dev');
    expect(a.conn.last('chat.error').code).toBe('device_disconnected');
    expect(b.conn.last('status').status).toBe('offline');
    device(core, 'dev2');
    expect(b.conn.last('status').status).toBe('online');
  });

  it('새 단말 연결은 이전 연결을 대체한다', () => {
    const core = makeCore();
    const d1 = device(core, 'd1');
    device(core, 'd2');
    expect(d1.conn.closed?.code).toBe(4001);
    expect(core.health().status).toBe('online');
  });

  it('스키마를 어긴 관람객 프레임은 연결을 끊는다', () => {
    const core = makeCore();
    const a = visitor(core, 'a');
    core.onMessage('a', JSON.stringify({ type: 'chat.request', evil: true }));
    expect(a.conn.closed?.code).toBe(1008);
  });

  it('관람객이 나가면 단말에 cancel 을 보낸다', () => {
    const core = makeCore();
    const d = device(core);
    const a = visitor(core, 'a');
    const r = a.ask();
    core.detach('a');
    expect(d.conn.last('cancel').requestId).toBe(r);
    expect(core.health().queueDepth).toBe(0);
  });

  it('휴면 뒤(pending 을 잃은 뒤)에도 sessionId 로 답을 전달한다', () => {
    const core = makeCore();
    const dConn = new FakeConn('dev');
    core.attachDevice(dConn, { engine: 'geniex', connectedAt: now - 5000, hello: true });
    const a = new FakeConn('a');
    const sid = newUuid();
    core.attachVisitor(a, '1.1.1.1', sid);
    const rid = newUuid();
    core.onMessage('dev', JSON.stringify({ type: 'chat.final', requestId: rid, sessionId: sid, reply: '깨어난 뒤의 답', animation: null, highlight: null, sourceFactIds: [], engine: 'geniex' }));
    expect(a.last('chat.final').reply).toBe('깨어난 뒤의 답');
  });

  it('POST 경로: 단발 요청이 최종 답으로 끝난다', async () => {
    const core = makeCore();
    const d = device(core);
    const sid = newUuid();
    const rid = newUuid();
    const p = core.submitHttp(JSON.stringify({ type: 'chat.request', requestId: rid, sessionId: sid, topic: 'general', message: 'q', clientVersion: '1' }), '3.3.3.3');
    d.final(rid, sid, 'http 답');
    const r = await p;
    expect(r.type === 'chat.final' && r.reply).toBe('http 답');
    expect(await core.submitHttp('{"type":"ping"}', '3.3.3.3')).toMatchObject({ type: 'bad_request' });
  });

  it('공개 health 에는 엔진·방문자 수 같은 상세가 없다', () => {
    const core = makeCore();
    device(core);
    expect(Object.keys(core.health()).sort()).toEqual(['connectedAt', 'queueDepth', 'status', 'version']);
    expect(core.adminStatus().engine).toBe('mock');
  });
});
