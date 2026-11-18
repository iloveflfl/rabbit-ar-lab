/**
 * 토끼 선생님 2D 리그 — 단 하나의 원본(source of truth).
 *
 * 모든 포즈·표정·애니메이션·설정화 시트는 이 파일의 벡터 부위에서 파생된다.
 * (런타임 캔버스 렌더러와 scripts/export-rabbit-sheets.ts 의 SVG 출력이 같은 정의를 읽는다.)
 * 토끼는 2D 부위별 리깅으로만 표현한다. 3D 메시가 아니다.
 *
 * 좌표: x → 오른쪽, y → 아래 (SVG 와 같음). 원점 = 두 발 사이 바닥.
 * 각 부위는 자기 pivot 을 원점으로 그리며, at = 부모 좌표계에서의 pivot 위치.
 *
 * 상태: 소유자가 2026-11-18 에 이 디자인을 확정했다 (assets/characters/rabbit/character_lock.json).
 * 외형을 바꾸면 모든 장면이 함께 바뀌므로, 바꾸기 전에 다시 승인받는다.
 */

export const PALETTE = {
  outline: '#6A4636',
  fur: '#FFEED4',
  furLight: '#FFFAF1',
  earInner: '#FFB9B4',
  blush: '#FF9E9E',
  nose: '#F28A8F',
  eye: '#3B2346',
  iris: '#C2477A',
  mouth: '#B0465B',
  coat: '#FFFFFF',
  coatTrim: '#63C7F2',
  tie: '#FFD44A',
  pointer: '#8A5A3C',
  star: '#FFD44A',
} as const;

export const EYES = ['open', 'closed', 'happy', 'wide'] as const;
export type EyeId = (typeof EYES)[number];
export const MOUTHS = ['smile', 'open', 'wide', 'o', 'grin'] as const;
export type MouthId = (typeof MOUTHS)[number];

export const PART_IDS = ['root', 'tail', 'footL', 'footR', 'body', 'head', 'earL', 'earR', 'browL', 'browR', 'armL', 'armR', 'pointer'] as const;
export type PartId = (typeof PART_IDS)[number];

export interface Shape {
  d: string;
  fill?: string;
  stroke?: string;
  sw?: number;
  opacity?: number;
  /** 이 조건일 때만 그린다 */
  eyes?: EyeId[];
  mouth?: MouthId[];
  pointer?: boolean;
  /** 시선 이동을 얼마나 따라가는가 (눈동자용) */
  look?: number;
}

export interface Part {
  id: PartId;
  at: [number, number];
  /** 기본 회전(도) */
  rest?: number;
  shapes: Shape[];
  back?: Part[];
  front?: Part[];
}

/** 디자인 화면: 520 × 600, 원점(발)은 (260, 570) */
export const VIEW = { w: 520, h: 600, ox: 260, oy: 570 } as const;

const P = PALETTE;
const SW = 5;
const n = (v: number) => Math.round(v * 100) / 100;
const ell = (cx: number, cy: number, rx: number, ry: number) =>
  `M ${n(cx - rx)},${n(cy)} A ${rx},${ry} 0 1,0 ${n(cx + rx)},${n(cy)} A ${rx},${ry} 0 1,0 ${n(cx - rx)},${n(cy)} Z`;

function star(cx: number, cy: number, r: number): string {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.46;
    d += `${i === 0 ? 'M' : 'L'} ${n(cx + Math.cos(a) * rr)},${n(cy + Math.sin(a) * rr)} `;
  }
  return d + 'Z';
}

const EAR_OUTER = 'M -22,6 C -35,-70 -31,-140 -7,-167 C 4,-178 17,-171 21,-150 C 31,-90 29,-40 22,6 Z';
const EAR_INNER = 'M -10,-10 C -19,-66 -17,-124 -4,-145 C 2,-153 8,-147 10,-134 C 17,-86 15,-44 10,-10 Z';

function ear(id: 'earL' | 'earR', x: number, rest: number): Part {
  return {
    id,
    at: [x, -170],
    rest,
    shapes: [
      { d: EAR_OUTER, fill: P.fur, stroke: P.outline, sw: SW },
      { d: EAR_INNER, fill: P.earInner },
    ],
  };
}

function eye(cx: number): Shape[] {
  const cy = -96;
  return [
    { d: ell(cx, cy, 14, 20), fill: P.eye, eyes: ['open'] },
    { d: ell(cx, cy + 9, 9.5, 9.5), fill: P.iris, eyes: ['open'], look: 0.6 },
    { d: ell(cx - 5, cy - 8, 5.2, 6.2), fill: '#FFFFFF', eyes: ['open'], look: 1 },
    { d: ell(cx + 5.5, cy + 10, 2.6, 2.6), fill: '#FFFFFF', opacity: 0.9, eyes: ['open'], look: 1 },
    { d: `M ${cx - 14},${cy + 2} Q ${cx},${cy + 13} ${cx + 14},${cy + 2}`, stroke: P.outline, sw: SW, eyes: ['closed'] },
    { d: `M ${cx - 15},${cy + 6} Q ${cx},${cy - 12} ${cx + 15},${cy + 6}`, stroke: P.outline, sw: SW, eyes: ['happy'] },
    { d: ell(cx, cy, 16, 22), fill: '#FFFFFF', stroke: P.outline, sw: 4, eyes: ['wide'] },
    { d: ell(cx, cy, 6.5, 8.5), fill: P.eye, eyes: ['wide'], look: 1 },
    { d: ell(cx - 2.5, cy - 3, 2.2, 2.6), fill: '#FFFFFF', eyes: ['wide'], look: 1 },
  ];
}

function arm(id: 'armL' | 'armR', x: number, rest: number, back?: Part[]): Part {
  return {
    id,
    at: [x, -96],
    rest,
    back,
    shapes: [
      { d: ell(0, 65, 15, 14), fill: P.fur, stroke: P.outline, sw: SW },
      { d: 'M -15,-4 C -19,24 -17,44 -14,56 L 14,56 C 17,44 19,24 15,-4 Q 0,-13 -15,-4 Z', fill: P.coat, stroke: P.outline, sw: SW },
      { d: 'M -15.5,43 L 15.5,43 L 14,56 L -14,56 Z', fill: P.coatTrim, stroke: P.outline, sw: 3.5 },
    ],
  };
}

const HEAD: Part = {
  id: 'head',
  at: [0, -108],
  back: [ear('earL', -48, -11), ear('earR', 48, 15)],
  shapes: [
    // 볼 털 (머리 뒤에서 살짝 튀어나온다)
    { d: 'M -104,-84 L -137,-66 L -113,-55 L -130,-36 L -96,-38 Z', fill: P.fur, stroke: P.outline, sw: SW },
    { d: 'M 104,-84 L 137,-66 L 113,-55 L 130,-36 L 96,-38 Z', fill: P.fur, stroke: P.outline, sw: SW },
    // 머리
    { d: 'M -118,-88 C -118,-152 -70,-192 0,-192 C 70,-192 118,-152 118,-88 C 118,-30 66,4 0,4 C -66,4 -118,-30 -118,-88 Z', fill: P.fur, stroke: P.outline, sw: SW },
    // 이마 털
    { d: 'M -22,-184 Q -17,-207 -4,-193 Q 2,-214 12,-193 Q 22,-205 23,-184 Q 0,-176 -22,-184 Z', fill: P.fur },
    { d: 'M -22,-185 Q -17,-207 -4,-193 Q 2,-214 12,-193 Q 22,-205 23,-185', stroke: P.outline, sw: SW },
    // 볼터치
    { d: ell(-84, -62, 16, 9.5), fill: P.blush, opacity: 0.55 },
    { d: ell(84, -62, 16, 9.5), fill: P.blush, opacity: 0.55 },
    // 주둥이
    { d: ell(0, -50, 46, 31), fill: P.furLight },
    ...eye(-52),
    ...eye(52),
    // 코
    { d: 'M -9,-68 Q 0,-73 9,-68 Q 7,-59 0,-57 Q -7,-59 -9,-68 Z', fill: P.nose, stroke: P.outline, sw: 3 },
    { d: 'M 0,-57 L 0,-50', stroke: P.outline, sw: 3.5 },
    // 입: 기본 ω
    { d: 'M -16,-51 Q -8,-40 0,-50 Q 8,-40 16,-51', stroke: P.outline, sw: 4, mouth: ['smile', 'open', 'wide'] },
    // 말할 때 벌어지는 입 + 앞니
    { d: 'M -8,-44 Q 0,-30 8,-44 Z', fill: P.mouth, stroke: P.outline, sw: 3, mouth: ['open'] },
    { d: 'M -10,-44 Q 0,-20 10,-44 Z', fill: P.mouth, stroke: P.outline, sw: 3, mouth: ['wide'] },
    { d: 'M -4.5,-45.5 L 4.5,-45.5 L 4,-39 L -4,-39 Z', fill: '#FFFFFF', stroke: P.outline, sw: 1.6, mouth: ['open', 'wide'] },
    // 놀란 입
    { d: ell(0, -41, 6.5, 7.5), fill: P.mouth, stroke: P.outline, sw: 3, mouth: ['o'] },
    // 활짝 웃는 입
    { d: 'M -17,-50 Q 0,-52 17,-50 Q 12,-28 0,-28 Q -12,-28 -17,-50 Z', fill: P.mouth, stroke: P.outline, sw: 3.5, mouth: ['grin'] },
    { d: 'M -5,-50.5 L 5,-50.5 L 4.5,-43 L -4.5,-43 Z', fill: '#FFFFFF', stroke: P.outline, sw: 1.6, mouth: ['grin'] },
  ],
  front: [
    { id: 'browL', at: [-52, -128], shapes: [{ d: 'M -11,2 Q 0,-4 11,1', stroke: P.outline, sw: 4 }] },
    { id: 'browR', at: [52, -128], shapes: [{ d: 'M -11,1 Q 0,-4 11,2', stroke: P.outline, sw: 4 }] },
  ],
};

const POINTER: Part = {
  id: 'pointer',
  at: [0, 66],
  shapes: [
    { d: 'M 0,0 L 0,92', stroke: P.pointer, sw: 6.5, pointer: true },
    { d: star(0, 104, 17), fill: P.star, stroke: P.outline, sw: 3.5, pointer: true },
  ],
};

const SNOW = (cx: number, cy: number, r: number) =>
  [0, 60, 120]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `M ${n(cx - Math.cos(a) * r)},${n(cy - Math.sin(a) * r)} L ${n(cx + Math.cos(a) * r)},${n(cy + Math.sin(a) * r)}`;
    })
    .join(' ');

const BODY: Part = {
  id: 'body',
  at: [0, -24],
  shapes: [
    // 실험 가운
    { d: 'M -46,-108 C -60,-80 -74,-30 -70,2 Q 0,18 70,2 C 74,-30 60,-80 46,-108 Q 0,-120 -46,-108 Z', fill: P.coat, stroke: P.outline, sw: SW },
    // 밑단 하늘색 띠
    { d: 'M -70,2 Q 0,18 70,2 L 71.5,-12 Q 0,4 -71.5,-12 Z', fill: P.coatTrim, stroke: P.outline, sw: 3.5 },
    // 가슴 털과 깃
    { d: 'M -22,-113 L 0,-70 L 22,-113 Z', fill: P.fur },
    { d: 'M -22,-113 L 0,-70 L 22,-113', stroke: P.outline, sw: 4 },
    { d: 'M 0,-70 L 0,3', stroke: P.outline, sw: 3 },
    { d: ell(10, -48, 4.2, 4.2), fill: P.coatTrim, stroke: P.outline, sw: 2 },
    { d: ell(10, -24, 4.2, 4.2), fill: P.coatTrim, stroke: P.outline, sw: 2 },
    // 주머니 + 눈꽃(극저온) 심벌
    { d: 'M -52,-46 L -24,-46 L -25,-24 Q -38,-19 -51,-24 Z', fill: P.coat, stroke: P.outline, sw: 3 },
    { d: SNOW(-38, -34, 7), stroke: P.coatTrim, sw: 2.6 },
    // 나비넥타이
    { d: 'M 0,-93 L -21,-104 L -21,-82 Z', fill: P.tie, stroke: P.outline, sw: 3.5 },
    { d: 'M 0,-93 L 21,-104 L 21,-82 Z', fill: P.tie, stroke: P.outline, sw: 3.5 },
    { d: ell(0, -93, 6, 6), fill: P.tie, stroke: P.outline, sw: 3.5 },
  ],
  front: [HEAD, arm('armL', -50, 14), arm('armR', 50, -14, [POINTER])],
};

function foot(id: 'footL' | 'footR', x: number): Part {
  return {
    id,
    at: [x, -12],
    shapes: [
      { d: ell(0, 0, 30, 15), fill: P.fur, stroke: P.outline, sw: SW },
      { d: 'M -9,-3 L -9,8 M 7,-3 L 7,8', stroke: P.outline, sw: 3 },
    ],
  };
}

export const RIG: Part = {
  id: 'root',
  at: [0, 0],
  shapes: [],
  front: [
    { id: 'tail', at: [80, -42], shapes: [{ d: ell(0, 0, 22, 20), fill: P.furLight, stroke: P.outline, sw: SW }] },
    foot('footL', -32),
    foot('footR', 32),
    BODY,
  ],
};

/* ───────── 포즈 ───────── */

export interface PartPose {
  r: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
}
export interface Pose {
  parts: Record<PartId, PartPose>;
  eyes: EyeId;
  mouth: MouthId;
  pointer: boolean;
  lookX: number;
  lookY: number;
}

export function makePose(): Pose {
  const parts = {} as Record<PartId, PartPose>;
  for (const id of PART_IDS) parts[id] = { r: 0, x: 0, y: 0, sx: 1, sy: 1 };
  return { parts, eyes: 'open', mouth: 'smile', pointer: false, lookX: 0, lookY: 0 };
}

export function resetPose(p: Pose): Pose {
  for (const id of PART_IDS) {
    const q = p.parts[id];
    q.r = 0;
    q.x = 0;
    q.y = 0;
    q.sx = 1;
    q.sy = 1;
  }
  p.eyes = 'open';
  p.mouth = 'smile';
  p.pointer = false;
  p.lookX = 0;
  p.lookY = 0;
  return p;
}

export function copyPose(from: Pose, to: Pose): Pose {
  for (const id of PART_IDS) Object.assign(to.parts[id], from.parts[id]);
  to.eyes = from.eyes;
  to.mouth = from.mouth;
  to.pointer = from.pointer;
  to.lookX = from.lookX;
  to.lookY = from.lookY;
  return to;
}

/** 숫자 채널은 보간하고, 표정 같은 이산 채널은 t 가 절반을 넘으면 b 를 따른다. */
export function blendPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  for (const id of PART_IDS) {
    const pa = a.parts[id];
    const pb = b.parts[id];
    const o = out.parts[id];
    o.r = pa.r + (pb.r - pa.r) * t;
    o.x = pa.x + (pb.x - pa.x) * t;
    o.y = pa.y + (pb.y - pa.y) * t;
    o.sx = pa.sx + (pb.sx - pa.sx) * t;
    o.sy = pa.sy + (pb.sy - pa.sy) * t;
  }
  const late = t > 0.35;
  out.eyes = late ? b.eyes : a.eyes;
  out.mouth = late ? b.mouth : a.mouth;
  out.pointer = late ? b.pointer : a.pointer;
  out.lookX = a.lookX + (b.lookX - a.lookX) * t;
  out.lookY = a.lookY + (b.lookY - a.lookY) * t;
  return out;
}

function visible(s: Shape, pose: Pose): boolean {
  if (s.eyes && !s.eyes.includes(pose.eyes)) return false;
  if (s.mouth && !s.mouth.includes(pose.mouth)) return false;
  if (s.pointer !== undefined && s.pointer !== pose.pointer) return false;
  return true;
}

/* ───────── 캔버스 렌더러 ───────── */

const pathCache = new Map<string, Path2D>();
const path = (d: string) => {
  let p = pathCache.get(d);
  if (!p) pathCache.set(d, (p = new Path2D(d)));
  return p;
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawPart(ctx: Ctx, part: Part, pose: Pose): void {
  const pp = pose.parts[part.id];
  ctx.save();
  ctx.translate(part.at[0] + pp.x, part.at[1] + pp.y);
  const rot = (part.rest ?? 0) + pp.r;
  if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);
  if (pp.sx !== 1 || pp.sy !== 1) ctx.scale(pp.sx, pp.sy);
  if (part.back) for (const c of part.back) drawPart(ctx, c, pose);
  for (const s of part.shapes) {
    if (!visible(s, pose)) continue;
    const p2 = path(s.d);
    const shifted = s.look !== undefined && (pose.lookX !== 0 || pose.lookY !== 0);
    if (shifted) {
      ctx.save();
      ctx.translate(pose.lookX * s.look!, pose.lookY * s.look!);
    }
    if (s.opacity !== undefined) ctx.globalAlpha = s.opacity;
    if (s.fill) {
      ctx.fillStyle = s.fill;
      ctx.fill(p2);
    }
    if (s.stroke) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.sw ?? SW;
      ctx.stroke(p2);
    }
    if (s.opacity !== undefined) ctx.globalAlpha = 1;
    if (shifted) ctx.restore();
  }
  if (part.front) for (const c of part.front) drawPart(ctx, c, pose);
  ctx.restore();
}

/** ctx 의 원점이 토끼의 발 위치가 되도록 변환한 뒤 호출한다. */
export function drawRabbit(ctx: Ctx, pose: Pose): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawPart(ctx, RIG, pose);
}

/* ───────── SVG 출력 (설정화 시트용) ───────── */

function partToSvg(part: Part, pose: Pose, indent: string): string {
  const pp = pose.parts[part.id];
  const rot = (part.rest ?? 0) + pp.r;
  const tf = [`translate(${n(part.at[0] + pp.x)} ${n(part.at[1] + pp.y)})`];
  if (rot !== 0) tf.push(`rotate(${n(rot)})`);
  if (pp.sx !== 1 || pp.sy !== 1) tf.push(`scale(${n(pp.sx)} ${n(pp.sy)})`);
  let out = `${indent}<g id="${part.id}" transform="${tf.join(' ')}">\n`;
  if (part.back) for (const c of part.back) out += partToSvg(c, pose, indent + '  ');
  for (const s of part.shapes) {
    if (!visible(s, pose)) continue;
    const attrs = [`d="${s.d}"`, `fill="${s.fill ?? 'none'}"`];
    if (s.stroke) attrs.push(`stroke="${s.stroke}"`, `stroke-width="${s.sw ?? SW}"`);
    if (s.opacity !== undefined) attrs.push(`opacity="${s.opacity}"`);
    if (s.look !== undefined && (pose.lookX !== 0 || pose.lookY !== 0)) attrs.push(`transform="translate(${n(pose.lookX * s.look)} ${n(pose.lookY * s.look)})"`);
    out += `${indent}  <path ${attrs.join(' ')}/>\n`;
  }
  if (part.front) for (const c of part.front) out += partToSvg(c, pose, indent + '  ');
  return out + `${indent}</g>\n`;
}

/** 토끼 한 마리를 <g> 로. 발 위치가 (x, y) 에 온다. */
export function rabbitSvgGroup(pose: Pose, x = 0, y = 0, scale = 1): string {
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${scale})" stroke-linejoin="round" stroke-linecap="round">\n${partToSvg(RIG, pose, '  ')}</g>\n`;
}

export function rabbitSvg(pose: Pose): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW.w} ${VIEW.h}" width="${VIEW.w * 4}" height="${VIEW.h * 4}">\n${rabbitSvgGroup(pose, VIEW.ox, VIEW.oy)}</svg>\n`;
}
