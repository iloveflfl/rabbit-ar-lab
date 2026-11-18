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
import type { HighlightId } from '@rabbit/shared';

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

/* ───────── 새 토끼 포스터의 패널 배치 ─────────
 * 원본 포스터의 섹션 순서(위→아래)를 그대로 따른다:
 * 제목 / MOTIVATION·METHODS / 열 응답 / 식각률·받침 / Cu·Mo / CONCLUSIONS
 */
export const HEADER: UvRect = { u0: 0, v0: 0, u1: 1, v1: 0.118 };

export const PANELS: Record<HighlightId, UvRect> = {
  motivation: { u0: 0.03, v0: 0.128, u1: 0.552, v1: 0.31 },
  methods: { u0: 0.568, v0: 0.128, u1: 0.97, v1: 0.31 },
  results_thermal_continuous: { u0: 0.03, v0: 0.32, u1: 0.492, v1: 0.538 },
  results_thermal_cyclic: { u0: 0.508, v0: 0.32, u1: 0.97, v1: 0.538 },
  results_etch_rate: { u0: 0.03, v0: 0.548, u1: 0.492, v1: 0.732 },
  results_mounting: { u0: 0.508, v0: 0.548, u1: 0.97, v1: 0.732 },
  results_cu_profile: { u0: 0.03, v0: 0.742, u1: 0.662, v1: 0.897 },
  results_mo: { u0: 0.678, v0: 0.742, u1: 0.97, v1: 0.897 },
  conclusions: { u0: 0.03, v0: 0.907, u1: 0.97, v1: 0.99 },
};

/** 3D 그래프·장비가 들어갈 자리. 포스터 그림(posterArt)과 3D 소품(props)이 같은 값을 쓴다. */
export const SLOTS = {
  chamber: subRect(PANELS.methods, 0.04, 0.2, 0.96, 0.8),
  thermometers: subRect(PANELS.results_thermal_continuous, 0.04, 0.3, 0.44, 0.9),
  cyclicChart: subRect(PANELS.results_thermal_cyclic, 0.05, 0.24, 0.95, 0.8),
  etchBars: subRect(PANELS.results_etch_rate, 0.04, 0.25, 0.54, 0.7),
  mountBars: subRect(PANELS.results_mounting, 0.04, 0.25, 0.96, 0.66),
  cuBars: subRect(PANELS.results_cu_profile, 0.03, 0.3, 0.64, 0.66),
  moStack: subRect(PANELS.results_mo, 0.06, 0.32, 0.5, 0.8),
} as const;

/** 막대 i 의 중심 u 좌표 (그림과 3D 막대가 같은 식을 쓴다) */
export const barU = (slot: UvRect, i: number, n: number) => slot.u0 + ((slot.u1 - slot.u0) * (i + 0.5)) / n;

/** QR 스티커가 붙는 자리(원본 Conclusions 오른쪽 빈 곳). 새 포스터에서도 비워 둔다. */
export const QR_ZONE: UvRect = { u0: 0.876, v0: 0.916, u1: 0.96, v1: 0.981 };

/** 실물(원본) 포스터에서 QR 스티커가 붙는 영역: CONCLUSIONS 띠의 오른쪽 빈 곳. 타깃을 만들 때 가린다. */
export const ORIGINAL_QR_ZONE: UvRect = { u0: 0.8, v0: 0.932, u1: 0.972, v1: 0.977 };

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
  /** 토끼 2D 평면 (약 11 cm 앞) */
  rabbit: 11 * CM,
  /** 떠다니는 입자의 최대 깊이 (약 22 cm) */
  particlesMax: 22 * CM,
} as const;

/** 토끼 스프라이트의 실제 크기(포스터 단위). 키 약 17 cm. */
export const RABBIT = {
  /** 텍스처 캔버스 전체 높이에 해당하는 평면 높이 */
  planeHeight: 0.36,
} as const;

/** 장면별 토끼 위치(u, v = 발 위치)와 바라보는 방향(-1 왼쪽, 1 오른쪽), 크기 배율 */
export interface Station {
  u: number;
  v: number;
  side: -1 | 1;
  scale: number;
}
export const STATIONS: Record<string, Station> = {
  intro: { u: 0.5, v: 0.66, side: 1, scale: 1.25 },
  plasma_basics: { u: 0.5, v: 0.31, side: 1, scale: 0.8 },
  continuous_heat: { u: 0.02, v: 0.545, side: 1, scale: 0.85 },
  cyclic_cooling: { u: 0.98, v: 0.545, side: -1, scale: 0.85 },
  etch_rates: { u: 0.02, v: 0.74, side: 1, scale: 0.85 },
  supports: { u: 0.98, v: 0.74, side: -1, scale: 0.85 },
  cu_profiles: { u: 0.02, v: 0.905, side: 1, scale: 0.8 },
  mo_reference: { u: 0.98, v: 0.905, side: -1, scale: 0.8 },
  conclusion: { u: 0.5, v: 0.9, side: 1, scale: 1.15 },
};

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
