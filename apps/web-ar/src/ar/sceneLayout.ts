/**
 * 포스터 좌표계와 모든 배치값을 한곳에 모은다.
 *
 * 포스터 로컬 좌표 (three.js, 오른손 좌표계)
 *   원점 = 포스터 중심, x → 오른쪽, y → 위, z → 포스터에서 관람객(카메라) 쪽
 *   단위 = 포스터 가로 폭 1 (실물 0.594 m). 세로는 841/594 ≈ 1.4158.
 *
 * MindAR 앵커는 "타깃 이미지 가로 폭 = 1, 원점 = 타깃 중심, +z = 카메라 쪽"으로 온다
 * (Controller._glModelViewMatrix + postMatrix). 타깃이 포스터 일부(crop)일 때는
 * targetToPoster() 가 주는 이동·배율로 포스터 전체 좌표계로 옮긴다.
 */

export const POSTER = {
  widthM: 0.594,
  heightM: 0.841,
  /** 세로/가로 */
  aspect: 841 / 594,
} as const;

export const H = POSTER.aspect;
/** 1 m 가 포스터 단위로 얼마인가 */
export const METER = 1 / POSTER.widthM;
export const CM = METER / 100;

/** 정규화 좌표 u(왼→오 0..1), v(위→아래 0..1) */
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export const uvToLocal = (u: number, v: number): [number, number] => [u - 0.5, (0.5 - v) * H];
export const localToUv = (x: number, y: number): [number, number] => [x + 0.5, 0.5 - y / H];
export const rectCenter = (r: UvRect): [number, number] => uvToLocal((r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2);
export const rectSize = (r: UvRect): [number, number] => [r.u1 - r.u0, (r.v1 - r.v0) * H];
/** 패널 안의 부분 사각형 (fx, fy 는 패널 기준 0..1) */
export const subRect = (r: UvRect, fx0: number, fy0: number, fx1: number, fy1: number): UvRect => ({
  u0: r.u0 + (r.u1 - r.u0) * fx0,
  v0: r.v0 + (r.v1 - r.v0) * fy0,
  u1: r.u0 + (r.u1 - r.u0) * fx1,
  v1: r.v0 + (r.v1 - r.v0) * fy1,
});

/* ───────── 슬라이드 한 장의 배치 ─────────
 * 덮어쓰는 화면은 포스터 전체를 한 장의 "발표 슬라이드"로 쓴다. 장면마다 슬라이드가 바뀐다.
 * 위에서부터: 머리줄 / 제목·설명 / 3D 시뮬 자리(HERO) / 개념 카드 / 한 줄 정리 / 진행 표시.
 * 그림(posterArt)과 3D 소품(props)이 같은 값을 쓴다.
 */
export const PAGE = {
  marginU: 0.06,
  top: { u0: 0.06, v0: 0.02, u1: 0.94, v1: 0.05 } as UvRect,
  title: { u0: 0.06, v0: 0.066, u1: 0.94, v1: 0.2 } as UvRect,
  lead: { u0: 0.06, v0: 0.205, u1: 0.94, v1: 0.272 } as UvRect,
  hero: { u0: 0.06, v0: 0.285, u1: 0.94, v1: 0.69 } as UvRect,
  cards: { u0: 0.06, v0: 0.706, u1: 0.94, v1: 0.872 } as UvRect,
  key: { u0: 0.06, v0: 0.888, u1: 0.75, v1: 0.946 } as UvRect,
  progress: { u0: 0.06, v0: 0.962, u1: 0.75, v1: 0.972 } as UvRect,
} as const;

/** 막대 i 의 중심 u 좌표 (그림과 3D 막대가 같은 식을 쓴다) */
export const barU = (slot: UvRect, i: number, n: number) => slot.u0 + ((slot.u1 - slot.u0) * (i + 0.5)) / n;

/** HERO 안에서 그래프가 실제로 서는 자리 (아래쪽은 축 이름표 자리로 남긴다) */
export const CHART: UvRect = subRect(PAGE.hero, 0.05, 0.1, 0.95, 0.74);

/** 실물(원본) 포스터에서 QR 스티커가 붙는 영역: CONCLUSIONS 띠의 오른쪽 빈 곳. 타깃을 만들 때 가린다. */
export const ORIGINAL_QR_ZONE: UvRect = { u0: 0.8, v0: 0.932, u1: 0.972, v1: 0.977 };

/* ───────── 진짜 포스터 읽기 ─────────
 * 해설 슬라이드가 끝나면 원본 포스터 → 같은 자리에 한국어로 바꾼 번역판을 보여 주고 구역별로 짚는다.
 * focus 는 그 장에서 밝게 남기는 구역 (원본 포스터의 띠 경계에 맞췄다).
 */
export const POSTER_IMG = { original: 'assets/poster/original.webp', ko: 'assets/poster/ko.webp' } as const;
export interface ReadView {
  tex: keyof typeof POSTER_IMG;
  focus: UvRect | null;
  accent: string;
}
const band = (v0: number, v1: number): UvRect => ({ u0: 0.012, v0, u1: 0.988, v1 });
export const READ_VIEW: Record<string, ReadView> = {
  original: { tex: 'original', focus: null, accent: '#F5F7FB' },
  read_overview: { tex: 'ko', focus: null, accent: '#4ADE9E' },
  read_motivation: { tex: 'ko', focus: band(0.092, 0.311), accent: '#5CC8FF' },
  read_thermal: { tex: 'ko', focus: band(0.313, 0.541), accent: '#FF7A59' },
  read_etch: { tex: 'ko', focus: band(0.542, 0.741), accent: '#F5C451' },
  read_metal: { tex: 'ko', focus: band(0.741, 0.926), accent: '#A78BFA' },
  read_conclusion: { tex: 'ko', focus: band(0.926, 0.981), accent: '#4ADE9E' },
};

/* ───────── 깊이(z) 계층 — 포스터 단위 ───────── */
export const Z = {
  /** 덮어쓰는 2D 포스터. 실물 종이와 z-fighting 이 나지 않을 만큼만 띄운다. */
  overlay: 0.003,
  /** 강조 테두리, 그림자 */
  decal: 0.006,
  /** 그래프 바닥판 */
  chartBase: 0.012,
  /** 3D 소품이 튀어나오는 기본 깊이 (약 2 cm) */
  prop: 2 * CM,
  /** 래비트 2D 평면: 포스터보다 약 18 cm 앞으로 나와 선다 */
  rabbit: 18 * CM,
  /** 떠다니는 입자의 최대 깊이 (약 22 cm) */
  particlesMax: 22 * CM,
} as const;

/** 토끼 스프라이트의 실제 크기(포스터 단위). 키 약 17 cm. */
export const RABBIT = {
  /** 텍스처 캔버스 전체 높이에 해당하는 평면 높이 */
  planeHeight: 0.36,
} as const;

/**
 * 안내 토끼 '래비트'가 서는 자리(u, v = 발 위치)와 바라보는 방향(-1 왼쪽, 1 오른쪽), 크기 배율.
 * AR 이니 포스터 안에 갇혀 있을 이유가 없다: 포스터 오른쪽 바깥(u > 1), 앞쪽(Z.rabbit)에 크게 서서 안쪽을 가리킨다.
 */
export interface Station {
  u: number;
  v: number;
  side: -1 | 1;
  scale: number;
}
export const GUIDE: Station = { u: 1.06, v: 0.69, side: -1, scale: 1.25 };
/** 장면마다 래비트가 서는 자리: 포스터를 읽을 때는 짚고 있는 구역 옆으로 옮겨 간다. */
export function guideFor(sceneId: string): Station {
  const focus = READ_VIEW[sceneId]?.focus;
  return focus ? { ...GUIDE, v: Math.min(0.985, focus.v1) } : GUIDE;
}

/* ───────── 이미지 타깃 ─────────
 * 포스터 전체가 화면에 다 안 들어오는 가까운 거리에서도 추적이 이어지도록
 * 전체 + 위쪽 + 아래쪽 세 타깃을 쓴다. 순서는 .mind 파일 안의 순서와 같아야 한다
 * (tools/compile-target.html 이 이 표를 그대로 읽어 잘라 낸다).
 * 아래쪽 타깃은 QR 스티커가 붙는 Conclusions 띠를 일부러 뺐다.
 */
export interface TargetDef {
  id: string;
  crop: UvRect;
  /** 컴파일할 때 쓸 가로 픽셀 수 */
  compileWidth: number;
}
export const TARGETS: TargetDef[] = [
  { id: 'full', crop: { u0: 0, v0: 0, u1: 1, v1: 1 }, compileWidth: 1011 },
  { id: 'upper', crop: { u0: 0, v0: 0, u1: 1, v1: 0.545 }, compileWidth: 1263 },
  { id: 'lower', crop: { u0: 0, v0: 0.535, u1: 1, v1: 0.925 }, compileWidth: 1263 },
];

/**
 * 타깃 앵커 좌표(타깃 폭 = 1, 타깃 중심 원점) → 포스터 좌표로 옮기는 값.
 * 앵커 아래에 { position, scale } 을 가진 그룹을 두고 그 안에 포스터 콘텐츠를 넣으면 된다.
 */
export function targetToPoster(t: TargetDef): { position: [number, number, number]; scale: number } {
  const cw = t.crop.u1 - t.crop.u0;
  const [cx, cy] = rectCenter(t.crop);
  return { position: [-cx / cw, -cy / cw, 0], scale: 1 / cw };
}

/** 새 포스터 텍스처 해상도 (A1 비율) */
export const POSTER_TEX = { width: 1448, height: 2050 } as const;
