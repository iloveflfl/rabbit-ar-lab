import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACT_IDS, HIGHLIGHT_IDS, LIMITS, PROTOCOL_VERSION, SCENE_ACTIONS, TOPIC_IDS } from '../src';

const kt = resolve(__dirname, '../../../apps/rabbit-server-android/app/src/main/java/kr/rabbitar/server/protocol/Ids.kt');

function listOf(src: string, name: string): string[] {
  const m = src.match(new RegExp(`val ${name} = listOf\(([^)]*)\)`, 's'));
  if (!m) throw new Error(`Ids.kt 에 ${name} 가 없습니다`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe('Android Ids.kt 는 packages/shared 와 같은 목록을 가진다', () => {
  it.runIf(existsSync(kt))('ID 목록과 한도', () => {
    const src = readFileSync(kt, 'utf8');
    expect(listOf(src, 'SCENE_ACTIONS')).toEqual([...SCENE_ACTIONS]);
    expect(listOf(src, 'HIGHLIGHT_IDS')).toEqual([...HIGHLIGHT_IDS]);
    expect(listOf(src, 'TOPIC_IDS')).toEqual([...TOPIC_IDS]);
    expect(listOf(src, 'FACT_IDS')).toEqual([...FACT_IDS]);
    expect(src).toContain(`PROTOCOL_VERSION = ${PROTOCOL_VERSION}`);
    expect(src).toContain(`MAX_MESSAGE_CHARS = ${LIMITS.maxMessageChars}`);
    expect(src).toContain(`MAX_REPLY_CHARS = ${LIMITS.maxReplyChars}`);
    expect(src).toContain(`MAX_DELTA_CHARS = ${LIMITS.maxDeltaChars}`);
  });
});
