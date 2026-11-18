/**
 * 웹 · 릴레이 · Android가 공유하는 유한 ID 목록.
 * Android 쪽 거울 사본: apps/rabbit-server-android/.../protocol/Ids.kt
 * (packages/shared/test/kotlin-sync.test.ts 가 두 목록이 같은지 검사한다)
 */

export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = '1.0.0';

/** LLM/서버가 고를 수 있는 AR 동작. poster_facts.json 의 allowed_scene_actions 와 동일해야 한다. */
export const SCENE_ACTIONS = [
  'rabbit_greet',
  'rabbit_explain',
  'rabbit_surprised',
  'show_heating',
  'show_cooling',
  'show_etch_rate',
  'show_mounting',
  'show_cu_profile',
  'show_mo',
] as const;
export type SceneAction = (typeof SCENE_ACTIONS)[number];

/** 새 포스터에서 강조할 수 있는 패널. */
export const HIGHLIGHT_IDS = [
  'motivation',
  'methods',
  'results_thermal_continuous',
  'results_thermal_cyclic',
  'results_etch_rate',
  'results_mounting',
  'results_cu_profile',
  'results_mo',
  'conclusions',
] as const;
export type HighlightId = (typeof HIGHLIGHT_IDS)[number];

/** poster_facts.json 의 safe_explanation_topics + 'general'. */
export const TOPIC_IDS = [
  'general',
  'research_overview',
  'plasma_etching_basics',
  'cryogenic_vs_sample_temp',
  'helium_backside_cooling',
  'continuous_heating',
  'cyclic_cooling',
  'sic_etch_rate',
  'mounting_comparison',
  'cu_step_height',
  'mo_reference',
] as const;
export type TopicId = (typeof TOPIC_IDS)[number];

/** poster_facts.json 의 facts[].id. */
export const FACT_IDS = [
  'semester1_si_glass_benchmark',
  'sic_continuous_minus50',
  'sic_cyclic_minus50',
  'sic_etch_rate_setpoints',
  'sic_mounting_comparison',
  'cu_profile_postprocessing',
  'mo_reference_etch',
] as const;
export type FactId = (typeof FACT_IDS)[number];

export const RABBIT_CLIPS = [
  'rabbit_idle',
  'rabbit_talk',
  'rabbit_point',
  'rabbit_surprised',
  'rabbit_cooling',
  'rabbit_cheer',
  'rabbit_think',
  'rabbit_wave',
] as const;
export type RabbitClip = (typeof RABBIT_CLIPS)[number];

/** 답변을 만든 주체. 화면에 그대로 구분 표시한다. */
export const ENGINES = ['geniex', 'lmstudio', 'mock', 'canned'] as const;
export type Engine = (typeof ENGINES)[number];

export const SERVER_STATUSES = ['online', 'offline', 'busy'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const ERROR_CODES = [
  'offline',
  'busy',
  'rate_limited',
  'budget_exhausted',
  'timeout',
  'cancelled',
  'bad_request',
  'duplicate_request',
  'device_error',
  'device_disconnected',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const LIMITS = {
  /** 관람객 질문 최대 글자 수 */
  maxMessageChars: 300,
  /** 최종 답변 최대 글자 수 (넘으면 릴레이가 자른다) */
  maxReplyChars: 900,
  /** 스트리밍 조각 하나의 최대 글자 수 */
  maxDeltaChars: 400,
  /** 수신 프레임 최대 바이트 */
  maxFrameBytes: 8 * 1024,
  /** 한 답변에 붙일 수 있는 근거 fact 수 */
  maxSourceFacts: 4,
  /** 세션 하나가 동시에 걸어둘 수 있는 요청 수 */
  maxPendingPerSession: 1,
  /** 릴레이 전체 대기열 길이 */
  maxQueueDepth: 8,
  /** 요청 제한: 세션당 분당 */
  sessionPerMinute: 6,
  /** 요청 제한: IP당 분당 */
  ipPerMinute: 20,
  /** 하루 총 요청 예산 */
  dailyBudget: 3000,
  /** 요청 하나의 최대 대기 시간 */
  requestTimeoutMs: 75_000,
  /** 동시에 붙을 수 있는 관람객 소켓 수 */
  maxVisitorSockets: 120,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const inList = <T extends string>(list: readonly T[]) => {
  const set = new Set<string>(list);
  return (v: unknown): v is T => typeof v === 'string' && set.has(v);
};
export const isSceneAction = inList(SCENE_ACTIONS);
export const isHighlightId = inList(HIGHLIGHT_IDS);
export const isTopicId = inList(TOPIC_IDS);
export const isFactId = inList(FACT_IDS);
export const isEngine = inList(ENGINES);
export const isServerStatus = inList(SERVER_STATUSES);
export const isErrorCode = inList(ERROR_CODES);
