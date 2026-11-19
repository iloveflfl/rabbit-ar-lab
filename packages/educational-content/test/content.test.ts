import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACT_IDS, HIGHLIGHT_IDS, SCENE_ACTIONS, TOPIC_IDS } from '@rabbit/shared';
import { posterKo, buildPrompt, cannedEntries, containsKeyword, llmContext, matchCanned, normalizeQuestion, parseModelOutput, posterFacts, sceneScripts, scenes } from '../src';

const fact = <T = any>(id: string): T => posterFacts.facts.find((f) => f.id === id) as T;

describe('poster_facts.json — 수치 보호', () => {
  it('인계 패키지 원본과 바이트 단위로 같다 (원본이 있을 때)', () => {
    const original = resolve(__dirname, '../../../_handoff/RabbitAR_Codex_Handoff_v2/data/poster_facts.json');
    if (!existsSync(original)) return;
    expect(readFileSync(resolve(__dirname, '../data/poster_facts.json'), 'utf8')).toBe(readFileSync(original, 'utf8'));
  });
  it('연속 플라즈마: 2.3→73°C, 홀더 3.2→98°C, 120 s, 칠러 −50°C', () => {
    const f = fact('sic_continuous_minus50');
    expect([f.sample_initial_c, f.sample_final_c, f.holder_initial_c, f.holder_final_c]).toEqual([2.3, 73, 3.2, 98]);
    expect(f.plasma_on_duration_s).toBe(120);
    expect(f.chiller_setpoint_c).toBe(-50);
  });
  it('반복 냉각: 11→27→14.5→30→16→32°C', () => {
    expect(fact('sic_cyclic_minus50').sequence.map((s: any) => s.sample_c)).toEqual([11, 27, 14.5, 30, 16, 32]);
  });
  it('SiC 식각률 201/75/185 nm/min, self-bias 116/103/115 V', () => {
    const c = fact('sic_etch_rate_setpoints').conditions;
    expect(c.map((x: any) => x.etch_rate_nm_per_min)).toEqual([201, 75, 185]);
    expect(c.map((x: any) => x.self_bias_v)).toEqual([116, 103, 115]);
    expect(c.map((x: any) => x.chiller_setpoint_c)).toEqual([-50, -40, -20]);
  });
  it('Cu 단차 세 쌍과 Mo ≈95 nm/min', () => {
    const cu = fact('cu_profile_postprocessing').comparisons;
    expect(cu.map((x: any) => [x.after_pr_strip_angstrom, x.after_di_hcl_angstrom])).toEqual([
      [10999, 3662],
      [14442, 11822],
      [11090, 10808],
    ]);
    expect(fact('mo_reference_etch').approx_etch_rate_nm_per_min).toBe(95);
  });
});

/** 문장 속 숫자를 뽑는다: 10,999 → 10999, −50 → 50 (부호 무시). */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, '')));
  return out;
}
function allNumbers(o: unknown, acc = new Set<number>()): Set<number> {
  if (typeof o === 'number') acc.add(Math.abs(o));
  else if (typeof o === 'string') for (const n of numbersIn(o)) acc.add(n);
  else if (Array.isArray(o)) o.forEach((x) => allNumbers(x, acc));
  else if (o && typeof o === 'object') Object.values(o).forEach((x) => allNumbers(x, acc));
  return acc;
}
const factNumbers = allNumbers(posterFacts.facts);
// 포스터 수치가 아닌 일상 숫자(번호, 배수, 단위 설명 등)
const HARMLESS = new Set([1, 2, 3, 4, 5, 6, 10, 0.1, 100000, 8, 30, 60, 500]);
const unknownNumbers = (text: string) => numbersIn(text).filter((n) => !factNumbers.has(n) && !HARMLESS.has(n));

describe('토끼 대사와 사전제작 답변은 포스터에 있는 숫자만 쓴다', () => {
  it('장면 대사', () => {
    for (const s of sceneScripts) expect({ id: s.id, unknown: unknownNumbers(s.lines.join(' ')).filter((n) => !(s.general_numbers ?? []).includes(n)) }).toEqual({ id: s.id, unknown: [] });
  });
  it('한국어 번역 포스터', () => {
    const printed = posterKo.printed_numbers;
    for (const b of posterKo.blocks as Array<{ t?: string }>) if (b.t) expect({ t: b.t, unknown: unknownNumbers(b.t).filter((n) => !printed.includes(n)) }).toEqual({ t: b.t, unknown: [] });
  });
  it('사전제작 답변', () => {
    for (const e of cannedEntries) expect({ id: e.id, unknown: unknownNumbers(e.reply) }).toEqual({ id: e.id, unknown: [] });
  });
  it('LLM 근거 요약', () => {
    for (const [id, text] of Object.entries(llmContext.facts_digest)) expect({ id, unknown: unknownNumbers(text) }).toEqual({ id, unknown: [] });
  });
});

describe('ID 정합성', () => {
  it('장면 대본은 scenes_ko.json 과 1:1', () => {
    expect(sceneScripts.map((s) => s.id)).toEqual(scenes.map((s) => s.id));
    for (const s of sceneScripts) {
      expect(TOPIC_IDS).toContain(s.topic);
      if (s.highlight) expect(HIGHLIGHT_IDS).toContain(s.highlight);
    }
  });
  it('사전제작 답변은 allowlist 안의 ID만 참조', () => {
    for (const e of cannedEntries) {
      expect(TOPIC_IDS).toContain(e.topic);
      if (e.animation) expect(SCENE_ACTIONS).toContain(e.animation);
      if (e.highlight) expect(HIGHLIGHT_IDS).toContain(e.highlight);
      for (const f of e.sourceFactIds) expect(FACT_IDS).toContain(f);
      for (const k of [...e.keywords, ...(e.must ?? []), ...(e.not ?? [])]) expect(k).toBe(normalizeQuestion(k));
    }
  });
  it('근거 요약은 모든 fact 를 덮는다', () => {
    expect(Object.keys(llmContext.facts_digest).sort()).toEqual([...FACT_IDS].sort());
  });
});

describe('질문 매칭', () => {
  it('표준 질문 3개', () => {
    expect(matchCanned('왜 영하 50도인데 기판은 73도야?').id).toBe('why_minus50_but_73');
    expect(matchCanned('SiC 식각은 뭐야?').id).toBe('what_is_sic_etching');
    expect(matchCanned('냉각을 왜 3분씩 했어?').id).toBe('why_cool_3min');
  });
  it('명세의 예시 질문', () => {
    expect(matchCanned('냉각기가 −50도인데 왜 기판은 73도야?').animation).toBe('show_heating');
    expect(matchCanned('30초만 식각하면 기판이 안 뜨거워?').animation).toBe('show_cooling');
    expect(matchCanned('−40도가 −20도보다 왜 더 안 깎였어?').animation).toBe('show_etch_rate');
  });
  it('Cu 단차를 식각률로 묻는 함정 질문에 넘어가지 않는다', () => {
    const a = matchCanned('구리 식각률은 얼마야?');
    expect(a.highlight).toBe('results_cu_profile');
    expect(a.reply).toMatch(/식각률이 없어|깎였다는 뜻은 아니야/);
  });
  it('Mo 식각률 질문은 SiC 식각률 답으로 새지 않는다', () => {
    expect(matchCanned('Mo 식각률은?').id).toBe('mo_reference');
    expect(matchCanned('SiC 식각률은 얼마야?').id).toBe('why_minus40_lowest');
  });
  it('영문·숫자 키워드는 다른 단어 속에서 맞지 않는다', () => {
    expect(containsKeyword('chiller', 'he')).toBe(false);
    expect(containsKeyword('he가뭐야', 'he')).toBe(true);
    expect(containsKeyword('175도', '75')).toBe(false);
    expect(containsKeyword('75nm', '75')).toBe(true);
    expect(matchCanned('motivation').id).toBe('fallback');
  });
  it('모르는 질문은 범위를 알려 주는 fallback', () => {
    const a = matchCanned('오늘 점심 뭐 먹지');
    expect(a.id).toBe('fallback');
    expect(a.strong).toBe(false);
  });
});

describe('LLM 입출력', () => {
  it('프롬프트에는 고른 주제의 근거만 들어간다', () => {
    const p = buildPrompt('식각률이 왜 75야?');
    expect(p.factIds).toEqual(['sic_etch_rate_setpoints']);
    expect(p.system).toContain('201/75/185');
    expect(p.system).not.toContain('10,999');
  });
  it("'#동작:' 줄을 떼어 내고 allowlist 로 거른다", () => {
    expect(parseModelOutput('설정값과 실제 온도는 달라!\n#동작: show_heating', SCENE_ACTIONS)).toEqual({ reply: '설정값과 실제 온도는 달라!', animation: 'show_heating' });
    expect(parseModelOutput('답이야 #동작: launch_missiles', SCENE_ACTIONS)).toEqual({ reply: '답이야', animation: null });
    expect(parseModelOutput('**굵게** <b>x</b>', SCENE_ACTIONS).reply).toBe('굵게 bx/b');
  });
});

describe('데스크탑(LM Studio) 단말용 프롬프트', () => {
  it('시스템 프롬프트에 규칙·모든 포스터 사실·대본이 들어 있다', async () => {
    const { fullSystemPrompt, llmContext, sceneScripts, desktopPrompt } = await import('../src/index');
    const s = fullSystemPrompt();
    expect(s).toContain(desktopPrompt.system_prompt);
    expect(s).toContain(desktopPrompt.primer[0]);
    for (const d of Object.values(llmContext.facts_digest)) expect(s).toContain(d);
    expect(s).toContain(sceneScripts[0].lines[0]);
  });

  it('직전 대화를 user/assistant 순서로 끼워 넣는다', async () => {
    const { buildFullPrompt } = await import('../src/index');
    const p = buildFullPrompt('더 자세히', 'general', [{ q: '왜 73도야?', a: '플라즈마가 열을 넣어서야.' }]);
    expect(p.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(p.messages.at(-1)!.content).toBe('더 자세히');
  });

  it('포스터 자료에 없는 숫자를 잡아낸다', async () => {
    const { findUnknownNumbers } = await import('../src/index');
    expect(findUnknownNumbers('시편은 2.3°C에서 73°C까지, 단차는 10,999 Å에서 3,662 Å로 바뀌었어.')).toEqual([]);
    expect(findUnknownNumbers('−50, −40, −20°C에서 201, 75, 185 nm/min 이야. 2가지 이유가 있어.')).toEqual([]);
    expect(findUnknownNumbers('영하 100도에서는 식각률이 312 nm/min 이야.')).toEqual(['100', '312']);
    expect(findUnknownNumbers('영하 100도 자료는 없어.', '영하 100도면 어때?')).toEqual([]);
  });
});

describe('큰 모델 출력 정리', () => {
  it('숨은 메모와 동작 태그를 떼고 문단은 살린다', async () => {
    const { parseDesktopOutput, stripThinking } = await import('../src/index');
    const raw = '<생각>의도: 온도 차이\n사실: 73도</생각>\n칠러는 **설정값**이야.\n\n시편은 73°C까지 올라갔어!\n#동작: show_heating';
    expect(parseDesktopOutput(raw, SCENE_ACTIONS)).toEqual({ reply: '칠러는 설정값이야.\n\n시편은 73°C까지 올라갔어!', animation: 'show_heating' });
    expect(stripThinking('<생각>아직 쓰는 중')).toBe('');
    expect(stripThinking('<생')).toBe('');
    // 닫는 태그를 빼먹은 경우: 첫 빈 줄까지만 메모로 본다
    expect(stripThinking('<생각>\n의도: 이유\n사실: 3분\n\n쉬는 동안 열이 빠져서야!\n\n#동작: show_cooling')).toBe('쉬는 동안 열이 빠져서야!\n\n#동작: show_cooling');
    expect(stripThinking('안녕 <생각>a</생각>반가워')).toBe('안녕 반가워');
  });

  it('지어낸 측정값 문장만 빼고 일반 지식의 숫자는 둔다', async () => {
    const { filterInventedMeasurements } = await import('../src/index');
    const ok = '플라즈마 속 전자는 보통 수만 도에 해당하는 에너지를 가져. 이 실험에서 시편은 73°C까지 올라갔어.';
    expect(filterInventedMeasurements(ok).removed).toEqual([]);
    const general = 'SiC는 일반적으로 2700도 근처까지 버티는 단단한 재료야.';
    expect(filterInventedMeasurements(general).reply).toBe(general);
    const bad = filterInventedMeasurements('칠러는 설정값일 뿐이야. 이 실험에서 시편은 412°C까지 올라갔어. 그래서 진짜 온도를 재야 해.');
    expect(bad.removed).toHaveLength(1);
    expect(bad.reply).toBe('칠러는 설정값일 뿐이야. 그래서 진짜 온도를 재야 해.');
  });
});
