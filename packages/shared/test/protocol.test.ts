import { describe, expect, it } from 'vitest';
import { LIMITS, SCENE_ACTIONS, newUuid, parseDeviceMessage, parseServerMessage, parseVisitorMessage } from '../src';
import facts from '../../educational-content/data/poster_facts.json';
import { FACT_IDS, TOPIC_IDS } from '../src';

const sid = newUuid();
const rid = newUuid();
const req = (over: object = {}) =>
  JSON.stringify({ type: 'chat.request', requestId: rid, sessionId: sid, topic: 'general', message: '왜 -50도인데 73도야?', clientVersion: '1.0.0', ...over });

describe('visitor frames', () => {
  it('accepts a well-formed chat.request', () => {
    const p = parseVisitorMessage(req());
    expect(p.ok).toBe(true);
  });
  it('rejects unknown fields, bad ids, unknown topics', () => {
    expect(parseVisitorMessage(req({ evil: 1 })).ok).toBe(false);
    expect(parseVisitorMessage(req({ requestId: 'abc' })).ok).toBe(false);
    expect(parseVisitorMessage(req({ topic: 'rm -rf' })).ok).toBe(false);
    expect(parseVisitorMessage(req({ selectedGraphId: 'nope' })).ok).toBe(false);
  });
  it('enforces message length and strips control characters', () => {
    expect(parseVisitorMessage(req({ message: 'x'.repeat(LIMITS.maxMessageChars + 1) })).ok).toBe(false);
    expect(parseVisitorMessage(req({ message: '   ' })).ok).toBe(false);
    const p = parseVisitorMessage(req({ message: 'a\u0000b\nc' }));
    expect(p.ok && p.value.type === 'chat.request' && p.value.message).toBe('ab c');
  });
  it('rejects non-JSON, arrays and oversized frames', () => {
    expect(parseVisitorMessage('nope').ok).toBe(false);
    expect(parseVisitorMessage('[]').ok).toBe(false);
    expect(parseVisitorMessage(new ArrayBuffer(4)).ok).toBe(false);
    expect(parseVisitorMessage(JSON.stringify({ type: 'ping', pad: 'x'.repeat(LIMITS.maxFrameBytes) })).ok).toBe(false);
  });
});

describe('device frames', () => {
  const final = (over: object = {}) =>
    JSON.stringify({ type: 'chat.final', requestId: rid, sessionId: sid, reply: '답', animation: 'show_heating', highlight: 'results_thermal_continuous', sourceFactIds: ['sic_continuous_minus50'], engine: 'mock', ...over });

  it('keeps allowlisted animation/highlight/facts', () => {
    const p = parseDeviceMessage(final());
    expect(p.ok && p.value.type === 'chat.final' && p.value.animation).toBe('show_heating');
  });
  it('drops (not rejects) anything outside the allowlists', () => {
    const p = parseDeviceMessage(final({ animation: 'eval(alert(1))', highlight: 'x', sourceFactIds: ['made_up', 'mo_reference_etch', 'mo_reference_etch'] }));
    expect(p.ok).toBe(true);
    if (p.ok && p.value.type === 'chat.final') {
      expect(p.value.animation).toBeNull();
      expect(p.value.highlight).toBeNull();
      expect(p.value.sourceFactIds).toEqual(['mo_reference_etch']);
    }
  });
  it('truncates over-long replies', () => {
    const p = parseDeviceMessage(final({ reply: '가'.repeat(LIMITS.maxReplyChars + 50) }));
    expect(p.ok && p.value.type === 'chat.final' && p.value.reply.length).toBe(LIMITS.maxReplyChars);
  });
  it('a device may not claim to be the canned engine in hello', () => {
    expect(parseDeviceMessage(JSON.stringify({ type: 'hello', protocol: 1, deviceVersion: '1.0.0', engine: 'canned' })).ok).toBe(false);
    expect(parseDeviceMessage(JSON.stringify({ type: 'hello', protocol: 1, deviceVersion: '1.0.0', engine: 'geniex' })).ok).toBe(true);
  });
  it('browser-side parser accepts what the relay forwards', () => {
    expect(parseServerMessage(final()).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ type: 'hello.ack', status: 'online', queueDepth: 0 })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ type: 'status', status: 'weird' })).ok).toBe(false);
  });
});

describe('ids stay in sync with poster_facts.json', () => {
  it('scene actions', () => {
    expect([...SCENE_ACTIONS]).toEqual(facts.allowed_scene_actions);
  });
  it('fact ids', () => {
    expect([...FACT_IDS]).toEqual(facts.facts.map((f) => f.id));
  });
  it('topics', () => {
    expect(TOPIC_IDS.filter((t) => t !== 'general')).toEqual(facts.safe_explanation_topics);
  });
});
