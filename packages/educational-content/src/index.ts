import type { FactId, HighlightId, SceneAction, TopicId } from '@rabbit/shared';
import factsJson from '../data/poster_facts.json';
import scenesJson from '../data/scenes_ko.json';
import scriptsJson from '../data/scene_scripts_ko.json';
import qaJson from '../data/qa_ko.json';
import llmJson from '../data/llm_ko.json';
import desktopJson from '../data/desktop_prompt_ko.json';
import posterKoJson from '../data/poster_ko.json';

export const posterFacts = factsJson;
export const scenes = scenesJson.scenes;
/** 원본 포스터 위에 같은 자리로 넣는 한국어 번역 (tools/build_poster_ko.py 의 입력) */
export const posterKo = posterKoJson;
export const sceneScripts = scriptsJson.scripts as Array<{
  id: string;
  chip: string;
  /** 0 시작 · 1 기초 지식 · 2 장비 · 3 결과 · 4 진짜 포스터 읽기 */
  part: 0 | 1 | 2 | 3 | 4;
  highlight: HighlightId | null;
  topic: TopicId;
  lines: string[];
  /** 포스터 측정값이 아닌 일반 지식의 숫자 (있을 때만) */
  general_numbers?: number[];
}>;
export const llmContext = llmJson as {
  system_prompt: string;
  action_tag: string;
  facts_digest: Record<FactId, string>;
  topic_routes: Array<{ topic: TopicId; keywords: string[]; factIds: FactId[]; animation: SceneAction; highlight: HighlightId }>;
};

export interface CannedEntry {
  id: string;
  topic: TopicId;
  keywords: string[];
  must?: string[];
  not?: string[];
  reply: string;
  animation: SceneAction | null;
  highlight: HighlightId | null;
  sourceFactIds: FactId[];
}
export interface CannedAnswer {
  id: string;
  reply: string;
  animation: SceneAction | null;
  highlight: HighlightId | null;
  sourceFactIds: FactId[];
  score: number;
  /** 키워드가 충분히 맞아서 LLM 없이 바로 써도 되는 답 */
  strong: boolean;
}

const qa = qaJson as unknown as {
  min_score: number;
  strong_score: number;
  fallback: Omit<CannedEntry, 'id' | 'topic' | 'keywords'>;
  entries: CannedEntry[];
};
export const cannedEntries = qa.entries;

/** 공백·문장부호 제거, 소문자화, 유니코드 마이너스 통일. Kotlin 쪽 TextMatch.normalize 와 같아야 한다. */
export function normalizeQuestion(s: string): string {
  return s
    .toLowerCase()
    .replace(/[−‒–—]/g, '-')
    .replace(/[\s.,!?~'"`()\[\]{}:;·…/\\°℃]+/g, '');
}

const isAsciiAlpha = (c: string) => c >= 'a' && c <= 'z';
const isDigit = (c: string) => c >= '0' && c <= '9';
const sameClass = (a: string, b: string) => (isAsciiAlpha(a) && isAsciiAlpha(b)) || (isDigit(a) && isDigit(b));

/**
 * 키워드 포함 검사. 영문·숫자 키워드는 같은 종류의 글자에 붙어 있으면 무시한다
 * ("he" 가 "chiller" 안에서 맞지 않도록, "75" 가 "175" 안에서 맞지 않도록).
 */
export function containsKeyword(normalized: string, keyword: string): boolean {
  let from = 0;
  for (;;) {
    const i = normalized.indexOf(keyword, from);
    if (i < 0) return false;
    const before = i > 0 ? normalized[i - 1] : '';
    const after = i + keyword.length < normalized.length ? normalized[i + keyword.length] : '';
    const leftOk = before === '' || !sameClass(before, keyword[0]);
    const rightOk = after === '' || !sameClass(after, keyword[keyword.length - 1]);
    if (leftOk && rightOk) return true;
    from = i + 1;
  }
}

export function scoreKeywords(normalized: string, keywords: readonly string[]): number {
  let score = 0;
  for (const k of keywords) if (containsKeyword(normalized, k)) score += Math.max(2, k.length);
  return score;
}

/** 사전제작 답변 찾기. 항상 답을 돌려준다(못 찾으면 fallback, score 0). */
export function matchCanned(message: string, topic: TopicId = 'general'): CannedAnswer {
  const n = normalizeQuestion(message);
  let best: CannedEntry | null = null;
  let bestScore = 0;
  for (const e of qa.entries) {
    if (e.must && !e.must.some((m) => containsKeyword(n, m))) continue;
    if (e.not && e.not.some((m) => containsKeyword(n, m))) continue;
    let s = scoreKeywords(n, e.keywords);
    if (s === 0) continue;
    if (e.topic === topic) s += 1.5;
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  if (!best || bestScore < qa.min_score) {
    return { id: 'fallback', ...qa.fallback, score: 0, strong: false };
  }
  return {
    id: best.id,
    reply: best.reply,
    animation: best.animation,
    highlight: best.highlight,
    sourceFactIds: best.sourceFactIds,
    score: bestScore,
    strong: bestScore >= qa.strong_score,
  };
}

/** 질문에 맞는 주제 경로(근거 fact + 기본 동작)를 고른다. */
export function routeTopic(message: string, topic: TopicId = 'general') {
  const n = normalizeQuestion(message);
  let best = llmContext.topic_routes.find((r) => r.topic === topic) ?? null;
  let bestScore = best ? 1 : 0;
  for (const r of llmContext.topic_routes) {
    const s = scoreKeywords(n, r.keywords) + (r.topic === topic ? 1 : 0);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

/** LLM에 넣을 프롬프트(시스템 + 근거 + 질문). 근거는 고른 주제의 fact만 넣어 짧게 유지한다. */
export function buildPrompt(message: string, topic: TopicId = 'general'): { system: string; user: string; factIds: FactId[] } {
  const route = routeTopic(message, topic);
  const factIds = route ? route.factIds : (['sic_continuous_minus50', 'sic_cyclic_minus50', 'sic_etch_rate_setpoints'] as FactId[]);
  const facts = factIds.map((id) => `- ${llmContext.facts_digest[id]}`).join('\n');
  return {
    system: `${llmContext.system_prompt}\n\n[포스터 사실]\n${facts}`,
    user: message,
    factIds,
  };
}

/** 모델 출력에서 '#동작: id' 줄을 떼어 낸다. 태그가 없거나 allowlist 밖이면 animation 은 null. */
export function parseModelOutput(raw: string, allowed: readonly string[]): { reply: string; animation: string | null } {
  const tag = llmContext.action_tag;
  let animation: string | null = null;
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const i = t.indexOf(tag);
    if (i >= 0) {
      const id = t.slice(i + tag.length).trim().replace(/[^a-z_]/g, '');
      if (animation === null && allowed.includes(id)) animation = id;
      const before = t.slice(0, i).trim();
      if (before) kept.push(before);
      continue;
    }
    if (t) kept.push(t);
  }
  const reply = kept.join(' ').replace(/[*_`#<>]/g, '').replace(/\s+/g, ' ').trim();
  return { reply, animation };
}

/* ───────────── 데스크탑(LM Studio) 단말용: 문서를 통째로 넣는 프롬프트 ───────────── */

export interface ChatTurn {
  q: string;
  a: string;
}

/** 전시자 PC 의 큰 모델용 지침과 배경지식 */
export const desktopPrompt = {
  system_prompt: (desktopJson.system_prompt as string[]).join('\n'),
  primer: desktopJson.primer as string[],
};

let fullSystemCache: string | null = null;

/**
 * 큰 문맥을 쓸 수 있는 모델용 시스템 프롬프트. 페르소나·규칙 + 포스터 사실 전부 + 원자료 JSON
 * + 장면 대본 + 모범 답변을 모두 넣는다. 항상 같은 문자열이라 서버의 프롬프트 캐시가 그대로 먹힌다.
 */
export function fullSystemPrompt(): string {
  if (fullSystemCache) return fullSystemCache;
  const digest = Object.values(llmContext.facts_digest)
    .map((t) => `- ${t}`)
    .join('\n');
  const scripts = sceneScripts.map((s) => `(${s.chip}) ${s.lines.join(' ')}`).join('\n');
  const examples = qa.entries.map((e) => `- ${e.reply}`).join('\n');
  fullSystemCache = [
    desktopPrompt.system_prompt,
    `[배경지식 — 쉬운 설명에 쓰는 일반 과학. 이 실험의 측정값이 아니다]\n${desktopPrompt.primer.map((t) => `- ${t}`).join('\n')}`,
    `[포스터 사실]\n${digest}`,
    `[포스터 원자료 JSON — 위 요약과 같은 내용의 원본. 숫자는 여기 있는 값만 쓴다]\n${JSON.stringify(posterFacts)}`,
    `[장면별 설명 대본 — 말투와 눈높이는 이것을 따라 한다]\n${scripts}`,
    `[모범 답변 — 비슷한 질문에는 이 내용과 어긋나지 않게 답한다]\n${examples}`,
  ].join('\n\n');
  return fullSystemCache;
}

/** OpenAI 호환 chat 메시지 배열. 직전 대화 몇 턴을 같이 넣어 "더 자세히" 같은 후속 질문을 받는다. */
export function buildFullPrompt(message: string, topic: TopicId = 'general', history: readonly ChatTurn[] = []) {
  const route = routeTopic(message, topic);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: fullSystemPrompt() }];
  for (const t of history) {
    messages.push({ role: 'user', content: t.q });
    messages.push({ role: 'assistant', content: t.a });
  }
  messages.push({ role: 'user', content: message });
  return { messages, route, factIds: (route ? route.factIds : []) as FactId[] };
}

function numbersIn(s: string): string[] {
  return (
    s
      .replace(/[−‒–—]/g, '-')
      .replace(/(\d),(?=\d{3})/g, '$1')
      .match(/\d+(?:\.\d+)?/g) ?? []
  );
}

/**
 * 답변에 나온 숫자 가운데 문맥(포스터 자료 + 질문)에 없는 것을 돌려준다. 비어 있으면 통과.
 * 10 이하의 정수는 "2가지", "1학년" 같은 일상 표현이라 허용한다.
 */
export function findUnknownNumbers(reply: string, question = ''): string[] {
  const allowed = new Set(numbersIn(fullSystemPrompt() + ' ' + question));
  return numbersIn(reply).filter((n) => !allowed.has(n) && !(Number.isInteger(Number(n)) && Number(n) <= 10));
}

/** 이 실험의 측정 이야기를 하고 있다는 표지. 이런 문장에 자료에 없는 숫자가 있으면 지어낸 측정값으로 본다. */
const EXPERIMENT_WORDS = ['시편', '홀더', '칠러', '식각률', 'nm/min', 'self-bias', '바이어스', '단차', 'Å', '이 실험', '이번 실험', '포스터', '측정', '쟀', 'sccm', 'mTorr'];
/** 일반 지식이나 추측이라고 밝힌 표지 */
const GENERAL_WORDS = ['보통', '일반적으로', '대략', '흔히', '예를 들어', '예를 들면', '추측', '가정', '만약', '비유', '쯤', '정도'];

/**
 * 답변에서 "지어낸 측정값"으로 보이는 문장만 골라 뺀다.
 * 자료(포스터 + 배경지식 + 질문)에 없는 숫자가 있고, 그 문장이 이 실험의 측정을 말하고 있으며,
 * 일반 지식·추측이라고 밝히지 않았을 때만 뺀다. 일반 과학 설명의 숫자는 그대로 둔다.
 */
export function filterInventedMeasurements(reply: string, question = ''): { reply: string; removed: string[] } {
  const removed: string[] = [];
  const paragraphs = reply.split(/\n{2,}/).map((para) => {
    const sentences = para.match(/[^.!?。]+[.!?。]+["')\]]*\s*|[^.!?。]+$/g) ?? [para];
    return sentences
      .filter((s) => {
        if (findUnknownNumbers(s, question).length === 0) return true;
        const experimental = EXPERIMENT_WORDS.some((w) => s.includes(w));
        const general = GENERAL_WORDS.some((w) => s.includes(w));
        if (experimental && !general) {
          removed.push(s.trim());
          return false;
        }
        return true;
      })
      .join('')
      .trim();
  });
  return { reply: paragraphs.filter(Boolean).join('\n\n'), removed };
}

const THINK_OPEN = '<생각>';
const THINK_CLOSE = '</생각>';

/**
 * 모델 출력에서 숨은 메모(<생각>…</생각>)를 뺀다.
 * 모델이 닫는 태그를 빼먹고 빈 줄 뒤에 바로 답을 쓰는 일이 있다(실측). 그때는 첫 빈 줄까지를 메모로 본다.
 * 닫히지도 않고 빈 줄도 아직 없으면(쓰는 중) 메모가 시작된 곳부터 전부 뺀다.
 */
export function stripThinking(raw: string): string {
  let s = raw;
  for (;;) {
    const a = s.indexOf(THINK_OPEN);
    if (a < 0) break;
    const b = s.indexOf(THINK_CLOSE, a);
    if (b >= 0) {
      s = s.slice(0, a) + s.slice(b + THINK_CLOSE.length);
      continue;
    }
    const rest = s.slice(a + THINK_OPEN.length);
    const gap = /\n[ \t]*\n/.exec(rest);
    s = s.slice(0, a) + (gap ? rest.slice(gap.index + gap[0].length) : '');
    break;
  }
  // 스트리밍 중에 '<생' 처럼 태그가 반쯤 온 경우도 가린다.
  for (let n = THINK_OPEN.length - 1; n > 0; n--) {
    if (s.endsWith(THINK_OPEN.slice(0, n))) return s.slice(0, -n);
  }
  return s;
}

/** 큰 모델의 출력 정리: 숨은 메모와 '#동작:' 줄을 떼고, 마크다운 기호를 지우되 문단 나눔은 살린다. */
export function parseDesktopOutput(raw: string, allowed: readonly string[]): { reply: string; animation: string | null } {
  const tag = llmContext.action_tag;
  let animation: string | null = null;
  const lines: string[] = [];
  for (const line of stripThinking(raw).split(/\r?\n/)) {
    const t = line.trim();
    const i = t.indexOf(tag);
    if (i >= 0) {
      const id = t.slice(i + tag.length).trim().replace(/[^a-z_]/g, '');
      if (animation === null && allowed.includes(id)) animation = id;
      const before = t.slice(0, i).trim();
      if (before) lines.push(before);
      continue;
    }
    lines.push(t);
  }
  const reply = lines
    .join('\n')
    .replace(/[*_`#<>]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  return { reply, animation };
}
