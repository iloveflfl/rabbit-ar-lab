import type { FactId, HighlightId, SceneAction, TopicId } from '@rabbit/shared';
import factsJson from '../data/poster_facts.json';
import scenesJson from '../data/scenes_ko.json';
import scriptsJson from '../data/scene_scripts_ko.json';
import qaJson from '../data/qa_ko.json';
import llmJson from '../data/llm_ko.json';

export const posterFacts = factsJson;
export const scenes = scenesJson.scenes;
export const sceneScripts = scriptsJson.scripts as Array<{
  id: string;
  chip: string;
  highlight: HighlightId | null;
  topic: TopicId;
  lines: string[];
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
