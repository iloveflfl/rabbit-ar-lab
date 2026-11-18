/**
 * 실물 포스터를 덮는 새 "토끼 입문 포스터"를 캔버스에 그린다.
 * 숫자는 전부 poster_facts.json 에서 읽는다. 여기서 숫자를 손으로 적지 않는다.
 * 움직이는 그래프·장비는 3D 소품(props)이 SLOTS 자리에 따로 올라간다.
 */
import type { HighlightId } from '@rabbit/shared';
import { posterFacts } from '@rabbit/content';
import { HEADER, PANELS, POSTER_TEX, QR_ZONE, SLOTS, type UvRect, barU } from '../ar/sceneLayout';
import { RabbitAnimator } from '../rabbit/clips';
import { drawRabbit } from '../rabbit/rig';

export const FONT_DISPLAY = `'Jua', 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif`;
export const FONT_BODY = `'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', system-ui, sans-serif`;

export const THEME = {
  navy: '#12264A',
  navyDeep: '#0B1A38',
  ink: '#1B2B4B',
  sub: '#5A6B88',
  paper: '#EAF6FF',
  card: '#FFFFFF',
  cold: '#1EB4EA',
  coldSoft: '#DDF3FD',
  heat: '#FF6B4A',
  heatSoft: '#FFE7E0',
  plasma: '#8B5CF6',
  plasmaSoft: '#EEE7FF',
  gold: '#FFB020',
  goldSoft: '#FFF2D2',
  mint: '#11B886',
  mintSoft: '#DBF6EC',
  yellow: '#FFD44A',
  slate: '#64748B',
} as const;

const W = POSTER_TEX.width;
const HH = POSTER_TEX.height;
type Ctx = CanvasRenderingContext2D;
interface Px {
  x: number;
  y: number;
  w: number;
  h: number;
}
const px = (r: UvRect): Px => ({ x: r.u0 * W, y: r.v0 * HH, w: (r.u1 - r.u0) * W, h: (r.v1 - r.v0) * HH });

const fact = (id: string): any => posterFacts.facts.find((f) => f.id === id);
/** 10999 → "10,999", −50 → "−50" (유니코드 마이너스) */
export const fmt = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US');

function rr(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function text(c: Ctx, s: string, x: number, y: number, size: number, color: string, opts: { font?: string; weight?: number; align?: CanvasTextAlign; base?: CanvasTextBaseline } = {}): number {
  c.font = `${opts.weight ?? 400} ${size}px ${opts.font ?? FONT_BODY}`;
  c.fillStyle = color;
  c.textAlign = opts.align ?? 'left';
  c.textBaseline = opts.base ?? 'alphabetic';
  c.fillText(s, x, y);
  return c.measureText(s).width;
}

/** 띄어쓰기 단위로 줄바꿈. 그린 줄 수를 돌려준다. */
function wrap(c: Ctx, s: string, x: number, y: number, maxW: number, lineH: number, size: number, color: string, opts: { font?: string; weight?: number; align?: CanvasTextAlign } = {}): number {
  c.font = `${opts.weight ?? 400} ${size}px ${opts.font ?? FONT_BODY}`;
  c.fillStyle = color;
  c.textAlign = opts.align ?? 'left';
  c.textBaseline = 'alphabetic';
  let line = '';
  let lines = 0;
  for (const word of s.split(' ')) {
    const trial = line ? `${line} ${word}` : word;
    if (line && c.measureText(trial).width > maxW) {
      c.fillText(line, x, y + lines * lineH);
      lines++;
      line = word;
    } else line = trial;
  }
  if (line) {
    c.fillText(line, x, y + lines * lineH);
    lines++;
  }
  return lines;
}

function chip(c: Ctx, s: string, x: number, y: number, size: number, bg: string, fg: string, opts: { font?: string; weight?: number; padX?: number; align?: 'left' | 'center' } = {}): number {
  c.font = `${opts.weight ?? 700} ${size}px ${opts.font ?? FONT_BODY}`;
  const padX = opts.padX ?? size * 0.6;
  const w = c.measureText(s).width + padX * 2;
  const h = size * 1.7;
  const left = opts.align === 'center' ? x - w / 2 : x;
  rr(c, left, y, w, h, h / 2);
  c.fillStyle = bg;
  c.fill();
  c.fillStyle = fg;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(s, left + padX, y + h / 2 + size * 0.04);
  return w;
}

function card(c: Ctx, p: Px, opts: { dark?: boolean } = {}): void {
  c.save();
  c.shadowColor = 'rgba(18,38,74,0.16)';
  c.shadowBlur = 26;
  c.shadowOffsetY = 8;
  rr(c, p.x, p.y, p.w, p.h, 30);
  if (opts.dark) {
    const g = c.createLinearGradient(p.x, p.y, p.x, p.y + p.h);
    g.addColorStop(0, '#16284F');
    g.addColorStop(1, '#0A1530');
    c.fillStyle = g;
  } else c.fillStyle = THEME.card;
  c.fill();
  c.restore();
}

function panelTitle(c: Ctx, p: Px, num: number, title: string, accent: string, dark = false): void {
  const cx = p.x + 50;
  const cy = p.y + 52;
  c.beginPath();
  c.arc(cx, cy, 27, 0, Math.PI * 2);
  c.fillStyle = accent;
  c.fill();
  text(c, String(num), cx, cy + 2, 34, '#FFFFFF', { font: FONT_DISPLAY, align: 'center', base: 'middle' });
  text(c, title, p.x + 90, cy + 3, 41, dark ? '#FFFFFF' : THEME.navy, { font: FONT_DISPLAY, base: 'middle' });
}

/** 3D 소품이 올라갈 자리의 은은한 무대 */
function stageFloor(c: Ctx, slot: UvRect, tint: string, baseline = true): void {
  const s = px(slot);
  rr(c, s.x, s.y, s.w, s.h, 18);
  c.fillStyle = tint;
  c.fill();
  if (baseline) {
    c.strokeStyle = 'rgba(18,38,74,0.22)';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(s.x + 10, s.y + s.h - 2);
    c.lineTo(s.x + s.w - 10, s.y + s.h - 2);
    c.stroke();
  }
}

function arrow(c: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, lw = 5): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = lw;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1 - Math.cos(a) * lw * 1.6, y1 - Math.sin(a) * lw * 1.6);
  c.stroke();
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x1 - Math.cos(a - 0.5) * lw * 3.4, y1 - Math.sin(a - 0.5) * lw * 3.4);
  c.lineTo(x1 - Math.cos(a + 0.5) * lw * 3.4, y1 - Math.sin(a + 0.5) * lw * 3.4);
  c.closePath();
  c.fill();
}

/* ───────── 머리띠 ───────── */
function drawHeader(c: Ctx): void {
  const p = px(HEADER);
  c.save();
  rr(c, 0, -40, W, p.h + 40, 46);
  c.clip();
  const g = c.createLinearGradient(0, 0, W, p.h);
  g.addColorStop(0, '#0E2148');
  g.addColorStop(0.55, '#1B3A7A');
  g.addColorStop(1, '#2A2E86');
  c.fillStyle = g;
  c.fillRect(0, 0, W, p.h);
  // 오로라 번짐
  for (const [bx, by, br, col] of [
    [W * 0.78, p.h * 0.2, 330, 'rgba(99,199,242,0.42)'],
    [W * 0.48, p.h * 1.05, 300, 'rgba(139,92,246,0.4)'],
    [W * 0.05, p.h * 0.1, 240, 'rgba(30,180,234,0.25)'],
  ] as Array<[number, number, number, string]>) {
    const rg = c.createRadialGradient(bx, by, 0, bx, by, br);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg;
    c.fillRect(0, 0, W, p.h);
  }
  // 눈꽃 점
  c.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 46; i++) {
    const x = (i * 197.3) % W;
    const y = (i * 71.9) % p.h;
    c.beginPath();
    c.arc(x, y, 1.2 + (i % 4) * 0.8, 0, Math.PI * 2);
    c.fill();
  }

  chip(c, '토끼 연구실 · 쉬운 과학 교실', 52, 20, 24, THEME.yellow, THEME.navy, { font: FONT_DISPLAY, weight: 400 });
  text(c, '차갑게 식히면서 깎기!', 50, 136, 84, '#FFFFFF', { font: FONT_DISPLAY });
  text(c, '플라즈마로 깎는 동안, 기판은 얼마나 뜨거워질까?', 54, 178, 32, '#CFE9FF', { weight: 700 });
  const m = posterFacts.metadata;
  text(c, m.corrected_ar_title, 54, 206, 17, 'rgba(255,255,255,0.78)');
  text(c, `${m.authors.join(', ').replace('*', '')}  ·  ${m.affiliation}`, 54, 228, 14.5, 'rgba(255,255,255,0.6)');

  // 머리띠 오른쪽에서 인사하는 토끼 (리그 원본에서 그린다)
  c.save();
  c.translate(W - 150, p.h + 26);
  c.scale(0.47, 0.47);
  drawRabbit(c, RabbitAnimator.still('rabbit_wave', 0.9, -1));
  c.restore();
  c.restore();
}

/* ───────── 1. 왜 식히면서 깎을까 ───────── */
function drawMotivation(c: Ctx): void {
  const p = px(PANELS.motivation);
  card(c, p);
  panelTitle(c, p, 1, '왜 식히면서 깎을까?', THEME.plasma);

  const tiles: Array<{ title: string; sub: string; tint: string; icon: (cx: number, cy: number) => void }> = [
    {
      title: '플라즈마가 두드려요',
      sub: '전기를 띤 알갱이',
      tint: THEME.plasmaSoft,
      icon: (cx, cy) => {
        c.fillStyle = THEME.plasma;
        for (let i = 0; i < 5; i++) {
          const x = cx - 56 + i * 28;
          const y = cy - 26 + ((i * 17) % 22);
          c.beginPath();
          c.arc(x, y, 7, 0, Math.PI * 2);
          c.fill();
          arrow(c, x, y + 12, x, y + 34, 'rgba(139,92,246,0.55)', 3);
        }
        rr(c, cx - 74, cy + 30, 148, 16, 5);
        c.fillStyle = THEME.navy;
        c.fill();
      },
    },
    {
      title: '표면이 깎여요',
      sub: "이걸 '식각'이라 해요",
      tint: THEME.coldSoft,
      icon: (cx, cy) => {
        c.fillStyle = THEME.navy;
        c.beginPath();
        c.moveTo(cx - 74, cy + 46);
        c.lineTo(cx - 74, cy + 2);
        c.lineTo(cx - 26, cy + 2);
        c.lineTo(cx - 26, cy + 26);
        c.lineTo(cx + 26, cy + 26);
        c.lineTo(cx + 26, cy + 2);
        c.lineTo(cx + 74, cy + 2);
        c.lineTo(cx + 74, cy + 46);
        c.closePath();
        c.fill();
        arrow(c, cx, cy - 30, cx, cy + 16, THEME.cold, 5);
      },
    },
    {
      title: '열도 같이 받아요',
      sub: '그래서 뜨거워져요!',
      tint: THEME.heatSoft,
      icon: (cx, cy) => {
        rr(c, cx - 74, cy + 30, 148, 16, 5);
        c.fillStyle = THEME.navy;
        c.fill();
        c.strokeStyle = THEME.heat;
        c.lineWidth = 6;
        c.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
          const x = cx + i * 40;
          c.beginPath();
          c.moveTo(x, cy + 18);
          c.bezierCurveTo(x - 14, cy + 4, x + 14, cy - 10, x, cy - 26);
          c.stroke();
        }
      },
    },
  ];
  const gap = 18;
  const tw = (p.w - 56 - gap * 2) / 3;
  const ty = p.y + 98;
  const th = 196;
  tiles.forEach((t, i) => {
    const x = p.x + 28 + i * (tw + gap);
    rr(c, x, ty, tw, th, 22);
    c.fillStyle = t.tint;
    c.fill();
    t.icon(x + tw / 2, ty + 62);
    text(c, t.title, x + tw / 2, ty + 148, 28, THEME.navy, { font: FONT_DISPLAY, align: 'center' });
    text(c, t.sub, x + tw / 2, ty + 180, 22, THEME.sub, { align: 'center', weight: 500 });
    if (i < 2) arrow(c, x + tw + 2, ty + th / 2, x + tw + gap - 2, ty + th / 2, THEME.navy, 4);
  });

  const s1 = fact('semester1_si_glass_benchmark');
  const by = p.y + p.h - 62;
  rr(c, p.x + 28, by, p.w - 56, 44, 14);
  c.fillStyle = '#F1F5FA';
  c.fill();
  text(c, `지난 학기(따로 한 실험): Si ${s1.etch_rate_nm_per_min.si} · 유리 ${s1.etch_rate_nm_per_min.glass} nm/min`, p.x + 46, by + 30, 23, THEME.sub, { weight: 500 });
}

/* ───────── 2. 실험 장치 ───────── */
function drawMethods(c: Ctx): void {
  const p = px(PANELS.methods);
  card(c, p, { dark: true });
  panelTitle(c, p, 2, '실험 장치 속으로', THEME.cold, true);
  const s = px(SLOTS.chamber);
  const g = c.createRadialGradient(s.x + s.w / 2, s.y + s.h * 0.45, 10, s.x + s.w / 2, s.y + s.h * 0.45, s.w * 0.62);
  g.addColorStop(0, 'rgba(139,92,246,0.34)');
  g.addColorStop(1, 'rgba(139,92,246,0)');
  c.fillStyle = g;
  c.fillRect(s.x, s.y, s.w, s.h);

  const f = fact('sic_continuous_minus50');
  const y = p.y + p.h - 58;
  let x = p.x + 24;
  for (const [label, col] of [
    [`${f.gas} ${f.gas_sccm} sccm`, '#2B3F6E'],
    [`He ${f.he_backside_pressure_torr} Torr`, '#2B3F6E'],
    [`칠러 설정 ${fmt(f.chiller_setpoint_c)}°C`, '#0E7FAE'],
  ] as Array<[string, string]>) {
    x += chip(c, label, x, y, 22, col, '#FFFFFF', { weight: 700, padX: 13 }) + 9;
  }
}

/* ───────── 3. 계속 켜면 ───────── */
function drawContinuous(c: Ctx): void {
  const p = px(PANELS.results_thermal_continuous);
  const f = fact('sic_continuous_minus50');
  card(c, p);
  panelTitle(c, p, 3, `계속 켜면? (${f.plasma_on_duration_s}초)`, THEME.heat);
  stageFloor(c, SLOTS.thermometers, '#FFF4F0');

  const x = p.x + p.w * 0.47;
  const y0 = p.y + 110;
  chip(c, `칠러 설정 ${fmt(f.chiller_setpoint_c)}°C`, x, y0, 24, THEME.coldSoft, '#0A6E99', { weight: 700 });
  text(c, '로 맞췄는데…', x + 4, y0 + 76, 24, THEME.sub, { weight: 500 });

  text(c, 'SiC 시편', x + 4, y0 + 128, 26, THEME.ink, { weight: 700 });
  let w = text(c, `${f.sample_initial_c}`, x + 4, y0 + 198, 46, THEME.sub, { font: FONT_DISPLAY });
  arrow(c, x + w + 16, y0 + 182, x + w + 58, y0 + 182, THEME.heat, 5);
  const w2 = text(c, `${f.sample_final_c}`, x + w + 70, y0 + 202, 92, THEME.heat, { font: FONT_DISPLAY });
  text(c, '°C', x + w + 74 + w2, y0 + 200, 40, THEME.heat, { font: FONT_DISPLAY });

  text(c, '홀더', x + 4, y0 + 252, 26, THEME.ink, { weight: 700 });
  w = text(c, `${f.holder_initial_c}`, x + 4, y0 + 304, 36, THEME.sub, { font: FONT_DISPLAY });
  arrow(c, x + w + 14, y0 + 292, x + w + 48, y0 + 292, THEME.gold, 4);
  const w3 = text(c, `${f.holder_final_c}`, x + w + 60, y0 + 306, 56, '#E08A00', { font: FONT_DISPLAY });
  text(c, '°C', x + w + 64 + w3, y0 + 304, 28, '#E08A00', { font: FONT_DISPLAY });
}

/* ───────── 4. 깎고 쉬기 ───────── */
function drawCyclic(c: Ctx): void {
  const p = px(PANELS.results_thermal_cyclic);
  const f = fact('sic_cyclic_minus50');
  card(c, p);
  panelTitle(c, p, 4, `${f.pulse_duration_s}초 깎고 ${f.cooling_duration_s / 60}분 쉬기`, THEME.cold);
  stageFloor(c, SLOTS.cyclicChart, '#F1FAFE');
  const y = p.y + p.h - 64;
  const up = f.per_pulse_increase_c as number[];
  const down = f.cooling_recovery_drop_c as number[];
  let x = p.x + 30;
  x += chip(c, `깎을 때 +${Math.min(...up)}~${Math.max(...up)}°C`, x, y, 23, THEME.heatSoft, '#C2401F', { weight: 700 }) + 10;
  chip(c, `쉴 때 −${Math.min(...down)}~${Math.max(...down)}°C`, x, y, 23, THEME.coldSoft, '#0A6E99', { weight: 700 });
}

/* ───────── 5. 깎는 속도 ───────── */
function drawEtch(c: Ctx): void {
  const p = px(PANELS.results_etch_rate);
  const f = fact('sic_etch_rate_setpoints');
  card(c, p);
  panelTitle(c, p, 5, 'SiC는 얼마나 빨리 깎였을까?', THEME.plasma);
  stageFloor(c, SLOTS.etchBars, '#F6F2FF');
  const s = px(SLOTS.etchBars);
  f.conditions.forEach((cond: any, i: number) => {
    const cx = barU(SLOTS.etchBars, i, f.conditions.length) * W;
    text(c, `${fmt(cond.chiller_setpoint_c)}°C`, cx, s.y + s.h + 36, 29, THEME.navy, { font: FONT_DISPLAY, align: 'center' });
    chip(c, `${cond.self_bias_v} V`, cx, s.y + s.h + 48, 21, '#EEF1F6', THEME.sub, { align: 'center', weight: 700, padX: 11 });
  });
  text(c, 'nm/min', s.x + 12, s.y + 26, 19, THEME.sub, { weight: 700 });

  const nx = p.x + p.w * 0.57;
  const ny = p.y + 96;
  const nw = p.x + p.w - 24 - nx;
  const nh = p.h - 96 - 26;
  rr(c, nx, ny, nw, nh, 20);
  c.fillStyle = THEME.goldSoft;
  c.fill();
  text(c, '순서대로가 아니네?', nx + 18, ny + 46, 29, '#8A5A00', { font: FONT_DISPLAY });
  wrap(c, '그때 전압(self-bias)도 함께 달랐어요. 온도 하나 때문이라고 단정할 수 없어요!', nx + 18, ny + 88, nw - 34, 33, 23.5, '#6B4A12', { weight: 500 });
}

/* ───────── 6. 받침대 ───────── */
const MOUNT_NAMES = ['작은 홀더', '8인치 Si 웨이퍼', 'Al 판', 'Al 판 + 그리스'];
function drawMounting(c: Ctx): void {
  const p = px(PANELS.results_mounting);
  const f = fact('sic_mounting_comparison');
  card(c, p);
  panelTitle(c, p, 6, `받침대를 바꾸면? (${f.duration_s}초 뒤)`, THEME.gold);
  stageFloor(c, SLOTS.mountBars, '#FFF8E8');
  const s = px(SLOTS.mountBars);
  text(c, '시편 온도', s.x + 12, s.y + 26, 19, THEME.sub, { weight: 700 });
  f.conditions.forEach((cond: any, i: number) => {
    const cx = barU(SLOTS.mountBars, i, f.conditions.length) * W;
    text(c, MOUNT_NAMES[i], cx, s.y + s.h + 34, 24, THEME.navy, { font: FONT_DISPLAY, align: 'center' });
    text(c, `홀더 ${cond.holder_c}°C`, cx, s.y + s.h + 64, 20, THEME.sub, { align: 'center', weight: 500 });
    chip(c, `${cond.self_bias_v} V`, cx, s.y + s.h + 76, 20, '#EEF1F6', THEME.sub, { align: 'center', weight: 700, padX: 11 });
  });
}

/* ───────── 7. 구리 단차 ───────── */
function drawCu(c: Ctx): void {
  const p = px(PANELS.results_cu_profile);
  const f = fact('cu_profile_postprocessing');
  card(c, p);
  panelTitle(c, p, 7, '구리 시편의 표면 단차', THEME.mint);
  // 범례
  let lx = p.x + 470;
  const ly = p.y + 40;
  for (const [label, col] of [
    ['PR 벗긴 뒤', '#B6C2D3'],
    ['묽은 염산 처리 뒤', THEME.mint],
  ] as Array<[string, string]>) {
    rr(c, lx, ly, 22, 22, 6);
    c.fillStyle = col;
    c.fill();
    lx += 30 + text(c, label, lx + 30, ly + 19, 21, THEME.sub, { weight: 700 }) + 20;
  }
  stageFloor(c, SLOTS.cuBars, '#EEFAF5');
  const s = px(SLOTS.cuBars);
  text(c, '단차 Å', s.x + 12, s.y + 26, 19, THEME.sub, { weight: 700 });
  f.comparisons.forEach((cmp: any, i: number) => {
    const cx = barU(SLOTS.cuBars, i, f.comparisons.length) * W;
    text(c, cmp.sample.replace(' ', ''), cx, s.y + s.h + 34, 27, THEME.navy, { font: FONT_DISPLAY, align: 'center' });
    text(c, `${fmt(cmp.after_pr_strip_angstrom)} → ${fmt(cmp.after_di_hcl_angstrom)}`, cx, s.y + s.h + 66, 22, THEME.ink, { align: 'center', weight: 700 });
  });

  const nx = p.x + p.w * 0.665;
  const ny = p.y + 92;
  const nw = p.x + p.w - 24 - nx;
  const nh = p.h - 92 - 24;
  rr(c, nx, ny, nw, nh, 20);
  c.fillStyle = THEME.heatSoft;
  c.fill();
  c.beginPath();
  c.arc(nx + 36, ny + 40, 19, 0, Math.PI * 2);
  c.fillStyle = THEME.heat;
  c.fill();
  text(c, '!', nx + 36, ny + 42, 30, '#FFFFFF', { font: FONT_DISPLAY, align: 'center', base: 'middle' });
  text(c, '헷갈리지 마요', nx + 64, ny + 50, 27, '#B8361A', { font: FONT_DISPLAY });
  wrap(c, "표면의 '높이 차이'를 잰 값이에요. 구리가 깎인 두께나 식각 속도가 아니에요.", nx + 18, ny + 92, nw - 34, 31, 23, '#7A2C1A', { weight: 500 });
}

/* ───────── 8. Mo 참고 ───────── */
function drawMo(c: Ctx): void {
  const p = px(PANELS.results_mo);
  const f = fact('mo_reference_etch');
  card(c, p);
  panelTitle(c, p, 8, 'Mo 참고 실험', THEME.slate);
  stageFloor(c, SLOTS.moStack, '#F2F4F8', false);
  const s = px(SLOTS.moStack);
  text(c, '개념도', s.x + s.w / 2, s.y + s.h + 28, 21, THEME.sub, { align: 'center', weight: 700 });
  const x = p.x + p.w * 0.54;
  text(c, '약', x, p.y + 132, 26, THEME.sub, { weight: 700 });
  const w = text(c, `${f.approx_etch_rate_nm_per_min}`, x + 34, p.y + 160, 84, THEME.navy, { font: FONT_DISPLAY });
  text(c, 'nm/min', x + 4, p.y + 196, 26, THEME.navy, { font: FONT_DISPLAY });
  void w;
  chip(c, `${f.pulse_duration_s}초 × ${f.pulse_count}번`, x, p.y + 216, 21, '#EEF1F6', THEME.sub, { weight: 700, padX: 11 });
  chip(c, `= ${f.cumulative_plasma_on_s}초`, x, p.y + 258, 21, '#EEF1F6', THEME.sub, { weight: 700, padX: 11 });
}

/* ───────── 결론 ───────── */
function drawConclusions(c: Ctx): void {
  const p = px(PANELS.conclusions);
  const cont = fact('sic_continuous_minus50');
  const cyc = fact('sic_cyclic_minus50');
  const er = fact('sic_etch_rate_setpoints');
  c.save();
  c.shadowColor = 'rgba(18,38,74,0.2)';
  c.shadowBlur = 26;
  c.shadowOffsetY = 8;
  rr(c, p.x, p.y, p.w, p.h, 30);
  const g = c.createLinearGradient(p.x, p.y, p.x + p.w, p.y + p.h);
  g.addColorStop(0, '#0E2148');
  g.addColorStop(1, '#1F3D82');
  c.fillStyle = g;
  c.fill();
  c.restore();

  text(c, '오늘 배운', p.x + 34, p.y + 68, 40, THEME.yellow, { font: FONT_DISPLAY });
  text(c, '세 가지', p.x + 34, p.y + 118, 40, THEME.yellow, { font: FONT_DISPLAY });
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(p.x + 226, p.y + 26);
  c.lineTo(p.x + 226, p.y + p.h - 26);
  c.stroke();

  const rates = er.conditions.map((x: any) => x.etch_rate_nm_per_min).join(' / ');
  const lines = [
    `플라즈마를 켜면 칠러 설정(${fmt(cont.chiller_setpoint_c)}°C)보다 훨씬 뜨거워져요 — ${cont.plasma_on_duration_s}초에 ${cont.sample_final_c}°C`,
    `${cyc.pulse_duration_s}초 깎고 ${cyc.cooling_duration_s / 60}분 쉬면 온도가 일부 되돌아와요`,
    `식각 속도 ${rates} nm/min — 온도와 전압이 함께 달랐어요`,
  ];
  lines.forEach((l, i) => {
    const y = p.y + 50 + i * 43;
    c.beginPath();
    c.arc(p.x + 268, y - 9, 16, 0, Math.PI * 2);
    c.fillStyle = [THEME.heat, THEME.cold, THEME.plasma][i];
    c.fill();
    text(c, String(i + 1), p.x + 268, y - 7, 22, '#FFFFFF', { font: FONT_DISPLAY, align: 'center', base: 'middle' });
    text(c, l, p.x + 298, y, 25.5, '#FFFFFF', { weight: 700 });
  });

  // QR 스티커 자리: 실물 포스터의 QR 이 붙는 곳. 덮어쓴 화면에서는 안내만 한다.
  const q = px(QR_ZONE);
  c.setLineDash([9, 8]);
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 3;
  rr(c, q.x, q.y, q.w, q.h, 16);
  c.stroke();
  c.setLineDash([]);
  text(c, 'QR로', q.x + q.w / 2, q.y + q.h / 2 - 8, 23, 'rgba(255,255,255,0.86)', { font: FONT_DISPLAY, align: 'center' });
  text(c, '여는 AR', q.x + q.w / 2, q.y + q.h / 2 + 22, 23, 'rgba(255,255,255,0.86)', { font: FONT_DISPLAY, align: 'center' });
}

export async function loadPosterFonts(): Promise<void> {
  if (!('fonts' in document)) return;
  const sample = '토끼 연구실 차갑게 식히면서 깎기 0123456789 왜 실험 장치 속으로 계속 켜면 초 분 쉬기 얼마나 빨리 깎였을까 받침대를 바꾸면 뒤 구리 시편의 표면 단차 참고 오늘 배운 세 가지 헷갈리지 마요 순서대로가 아니네 작은 홀더 인치 웨이퍼 판 그리스 플라즈마가 두드려요 표면이 깎여요 열도 같이 받아요 약 여는 번 설정 칠러 SiC Mo Al nm/min QR AR °C −+→';
  try {
    await Promise.race([document.fonts.load(`400 40px 'Jua'`, sample), new Promise((r) => setTimeout(r, 3500))]);
  } catch {
    /* 글꼴을 못 받아도 시스템 글꼴로 그린다 */
  }
}

export function paintPoster(canvas: HTMLCanvasElement): void {
  canvas.width = W;
  canvas.height = HH;
  const c = canvas.getContext('2d')!;
  // 종이 바탕
  const bg = c.createLinearGradient(0, 0, 0, HH);
  bg.addColorStop(0, '#E3F3FF');
  bg.addColorStop(0.5, '#EEF8FF');
  bg.addColorStop(1, '#E6F1FF');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, HH);
  c.fillStyle = 'rgba(30,180,234,0.10)';
  for (let y = 16; y < HH; y += 34) for (let x = 16 + ((y / 34) % 2) * 17; x < W; x += 34) c.fillRect(x, y, 3, 3);

  drawHeader(c);
  drawMotivation(c);
  drawMethods(c);
  drawContinuous(c);
  drawCyclic(c);
  drawEtch(c);
  drawMounting(c);
  drawCu(c);
  drawMo(c);
  drawConclusions(c);
}

/** 패널의 짧은 이름 (HUD·접근성 라벨용) */
export const PANEL_LABELS: Record<HighlightId, string> = {
  motivation: '왜 식히면서 깎을까?',
  methods: '실험 장치',
  results_thermal_continuous: '계속 켜면?',
  results_thermal_cyclic: '깎고 쉬기',
  results_etch_rate: '깎는 속도',
  results_mounting: '받침대',
  results_cu_profile: '구리 단차',
  results_mo: 'Mo 참고',
  conclusions: '정리',
};
