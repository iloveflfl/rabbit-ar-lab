/**
 * 실물 포스터를 덮는 "발표 슬라이드"를 캔버스에 그린다. 장면마다 한 장이다.
 * 측정값은 전부 poster_facts.json 에서 읽는다. 여기서 측정값을 손으로 적지 않는다.
 * 움직이는 시뮬레이션·그래프는 3D 소품(props)이 HERO 자리에 따로 올라간다.
 */
import { posterFacts, sceneScripts } from '@rabbit/content';
import { CHART, PAGE, POSTER_TEX, type UvRect, barU, subRect } from '../ar/sceneLayout';

export const FONT_BODY = `'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif`;
export const FONT_DISPLAY = FONT_BODY;

export const THEME = {
  bg0: '#05070D',
  bg1: '#0B1120',
  ink: '#F5F7FB',
  dim: 'rgba(232,238,255,0.64)',
  faint: 'rgba(232,238,255,0.38)',
  line: 'rgba(255,255,255,0.11)',
  panel: 'rgba(255,255,255,0.035)',
  cold: '#5CC8FF',
  heat: '#FF7A59',
  plasma: '#A78BFA',
  gold: '#F5C451',
  mint: '#4ADE9E',
  slate: '#9AA7C2',
  copper: '#E8935A',
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

export const fact = (id: string): any => posterFacts.facts.find((f) => f.id === id);
/** 10999 → "10,999", −50 → "−50" (유니코드 마이너스) */
export const fmt = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US');

/** 그린 글자를 모아 둔다: 글꼴이 글자 묶음(subset)별로 나뉘어 있어, 쓸 글자를 미리 알려 줘야 한다. */
const USED = new Set<string>();
export const noteGlyphs = (s: string) => USED.add(s);
let dry = false;

function rr(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

interface TextOpts {
  weight?: number;
  align?: CanvasTextAlign;
  base?: CanvasTextBaseline;
  /** 글자 사이(px) */
  track?: number;
}
function setFont(c: Ctx, size: number, o: TextOpts): void {
  c.font = `${o.weight ?? 500} ${size}px ${FONT_BODY}`;
  (c as Ctx & { letterSpacing: string }).letterSpacing = `${o.track ?? 0}px`;
}
function text(c: Ctx, s: string, x: number, y: number, size: number, color: string | CanvasGradient, o: TextOpts = {}): number {
  USED.add(s);
  setFont(c, size, o);
  const w = c.measureText(s).width;
  if (dry) return w;
  c.fillStyle = color;
  c.textAlign = o.align ?? 'left';
  c.textBaseline = o.base ?? 'alphabetic';
  c.fillText(s, x, y);
  return w;
}

/** 띄어쓰기 단위로 줄바꿈. 그린 줄 수를 돌려준다. */
function wrap(c: Ctx, s: string, x: number, y: number, maxW: number, lineH: number, size: number, color: string, o: TextOpts & { maxLines?: number } = {}): number {
  USED.add(s);
  setFont(c, size, o);
  c.fillStyle = color;
  c.textAlign = o.align ?? 'left';
  c.textBaseline = 'alphabetic';
  const out: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    const trial = line ? `${line} ${word}` : word;
    if (line && c.measureText(trial).width > maxW) {
      out.push(line);
      line = word;
    } else line = trial;
  }
  if (line) out.push(line);
  const lines = out.slice(0, o.maxLines ?? 99);
  if (!dry) lines.forEach((l, i) => c.fillText(l, x, y + i * lineH));
  return lines.length;
}

function pill(c: Ctx, s: string, x: number, y: number, size: number, fg: string, bg: string, o: { align?: 'left' | 'center' | 'right'; stroke?: string } = {}): number {
  setFont(c, size, { weight: 650 });
  const padX = size * 0.72;
  const w = c.measureText(s).width + padX * 2;
  const h = size * 1.9;
  const left = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  rr(c, left, y, w, h, h / 2);
  c.fillStyle = bg;
  c.fill();
  if (o.stroke) {
    c.strokeStyle = o.stroke;
    c.lineWidth = 1.5;
    c.stroke();
  }
  text(c, s, left + padX, y + h / 2 + size * 0.04, size, fg, { weight: 650, base: 'middle' });
  return w;
}

const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

function glow(c: Ctx, x: number, y: number, r: number, color: string, a: number): void {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, alpha(color, a));
  g.addColorStop(1, alpha(color, 0));
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}

/* ───────────────────────── 슬라이드 정의 ───────────────────────── */

interface Card {
  /** 작은 머리말 */
  k: string;
  /** 큰 글자 */
  t: string;
  /** 설명 */
  d: string;
}
interface PageDef {
  id: string;
  eyebrow: string;
  title: [string, string];
  lead: string;
  accent: string;
  cards: Card[];
  key: string;
  hero?: (c: Ctx, r: Px, accent: string) => void;
}

const PART_NAME = ['', 'PART 1 · 먼저 알아야 할 것', 'PART 2 · 이 연구의 장비', 'PART 3 · 직접 잰 결과'];

/** 그래프 아래 축 이름표 한 칸 */
function axisLabel(c: Ctx, cx: number, y: number, main: string, subs: string[], color = THEME.ink): void {
  text(c, main, cx, y, 34, color, { weight: 750, align: 'center' });
  subs.forEach((s, i) => text(c, s, cx, y + 40 + i * 33, 24, THEME.dim, { weight: 500, align: 'center' }));
}

function chartFrame(c: Ctx, unit: string): Px {
  const s = px(CHART);
  c.strokeStyle = THEME.line;
  c.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const y = s.y + (s.h * i) / 4;
    c.globalAlpha = i === 4 ? 1 : 0.5;
    c.beginPath();
    c.moveTo(s.x, y);
    c.lineTo(s.x + s.w, y);
    c.stroke();
  }
  c.globalAlpha = 1;
  text(c, unit, s.x, s.y - 14, 23, THEME.faint, { weight: 600, track: 1 });
  return s;
}

function zigzag(c: Ctx, x: number, y0: number, y1: number, color: string): void {
  const n = 7;
  const amp = 15;
  c.strokeStyle = color;
  c.lineWidth = 4;
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(x, y0);
  const a = y0 + (y1 - y0) * 0.14;
  const b = y1 - (y1 - y0) * 0.14;
  c.lineTo(x, a);
  for (let i = 0; i < n; i++) c.lineTo(x + (i % 2 ? -amp : amp), a + ((b - a) * (i + 0.5)) / n);
  c.lineTo(x, b);
  c.lineTo(x, y1);
  c.stroke();
}

function buildPages(): PageDef[] {
  const cont = fact('sic_continuous_minus50');
  const cyc = fact('sic_cyclic_minus50');
  const er = fact('sic_etch_rate_setpoints');
  const mt = fact('sic_mounting_comparison');
  const cu = fact('cu_profile_postprocessing');
  const mo = fact('mo_reference_etch');
  const m = posterFacts.metadata;
  const up = cyc.per_pulse_increase_c as number[];
  const down = cyc.cooling_recovery_drop_c as number[];
  const seq = (cyc.sequence as Array<{ sample_c: number }>).map((s) => s.sample_c);
  const set = fmt(cont.chiller_setpoint_c);
  const rates = er.conditions.map((x: any) => x.etch_rate_nm_per_min);
  const biases = er.conditions.map((x: any) => x.self_bias_v);
  const temps = er.conditions.map((x: any) => x.sample_temp_at_120s_c);
  const mBias = mt.conditions.map((x: any) => x.self_bias_v);
  const MOUNT = ['작은 홀더', '8인치 Si', 'Al 판', 'Al 판 + 그리스'];

  return [
    {
      id: 'intro',
      eyebrow: 'CRYOGENIC PLASMA ETCHING',
      title: [`${set}°C로 식혔는데,`, `기판은 왜 ${cont.sample_final_c}°C일까?`],
      lead: '반도체를 깎는 플라즈마 장비 안에서 SiC와 Cu가 실제로 얼마나 뜨거워지고, 얼마나 깎이는지 직접 재 본 연구예요.',
      accent: THEME.cold,
      cards: [
        { k: 'PART 1', t: '먼저 알아야 할 것', d: '식각이 뭔지, 플라즈마가 뭔지, 어떻게 만드는지' },
        { k: 'PART 2', t: '이 연구의 장비', d: 'ICP-RIE 장비의 구조와 열이 빠져나가는 길' },
        { k: 'PART 3', t: '직접 잰 결과', d: '시편 온도, 깎이는 속도, 받침대와 금속 시편' },
      ],
      key: `${m.corrected_ar_title}`,
      hero: (c, r) => {
        text(c, m.authors.join(' · ').replace('*', ''), r.x + r.w / 2, r.y + r.h - 62, 25, THEME.dim, { weight: 600, align: 'center' });
        text(c, 'Plasma & Device Laboratory · Korea University Sejong', r.x + r.w / 2, r.y + r.h - 26, 21, THEME.faint, { weight: 500, align: 'center', track: 0.5 });
      },
    },
    {
      id: 'why_etch',
      eyebrow: PART_NAME[1],
      title: ['반도체 칩은', "'깎아서' 만든다"],
      lead: "얇은 막을 쌓고, 남길 곳만 가린 뒤, 나머지를 깎아 내요. 이 '깎기'를 식각(etching)이라고 해요.",
      accent: THEME.plasma,
      cards: [
        { k: 'STEP 1', t: '쌓기 · 증착', d: '재료를 아주 얇은 막으로 입혀요' },
        { k: 'STEP 2', t: '가리기 · 감광막', d: '남길 무늬만 감광막(PR)으로 덮어요' },
        { k: 'STEP 3', t: '깎기 · 식각', d: '덮이지 않은 곳을 파내요. 이 포스터의 주제예요' },
      ],
      key: "약품에 담그면 습식, 플라즈마로 깎으면 '건식 식각'. 이 연구는 건식 식각이에요.",
    },
    {
      id: 'plasma_state',
      eyebrow: PART_NAME[1],
      title: ['플라즈마는', '물질의 네 번째 상태'],
      lead: '기체에 전기 에너지를 주면 원자에서 전자가 떨어져 나와요. 번개, 네온사인, 형광등 속이 모두 플라즈마예요.',
      accent: THEME.plasma,
      cards: [
        { k: '전자 (−)', t: '가볍고 빠르다', d: '다른 원자와 부딪혀 플라즈마를 계속 만들어요' },
        { k: '이온 (+)', t: '무겁고 끌려간다', d: '전기장을 따라 날아가 표면을 때려요' },
        { k: '라디칼', t: '반응을 잘한다', d: '전기는 띠지 않지만 표면과 화학 반응을 해요' },
      ],
      key: '고체 → 액체 → 기체 → 플라즈마. 에너지를 줄수록 입자가 자유로워져요.',
      hero: (c, r) => {
        const items: Array<[string, string]> = [
          ['중성 원자', '#8C97AE'],
          ['이온 (+)', THEME.plasma],
          ['전자 (−)', THEME.cold],
        ];
        let x = r.x + 44;
        for (const [name, col] of items) {
          c.beginPath();
          c.arc(x + 10, r.y + r.h - 46, 10, 0, Math.PI * 2);
          c.fillStyle = col;
          c.fill();
          x += 34 + text(c, name, x + 30, r.y + r.h - 37, 25, THEME.dim, { weight: 600 }) + 34;
        }
      },
    },
    {
      id: 'how_etch',
      eyebrow: PART_NAME[1],
      title: ['때리고, 반응시켜', '수직으로 판다'],
      lead: '라디칼의 화학 반응만 쓰면 옆으로도 파여요. 이온을 수직으로 떨어뜨려 함께 쓰면 벽이 반듯하게 서요.',
      accent: THEME.plasma,
      cards: [
        { k: '화학', t: '라디칼의 반응', d: '표면 원자와 결합해 기체가 되어 날아가요. 사방으로 깎여요' },
        { k: '물리', t: '이온의 충돌', d: '전기장을 따라 수직으로 떨어져 바닥만 때려요' },
        { k: 'RIE', t: '둘을 함께', d: 'Reactive Ion Etching, 반응성 이온 식각이에요' },
      ],
      key: '이온이 수직으로 떨어지는 이유: 전하는 전기장 방향으로 힘을 받아요 (F = qE).',
      hero: (c, r) => {
        const cols: Array<[string, string, string]> = [
          ['화학 반응만', '옆으로도 파여요', THEME.mint],
          ['이온 + 화학 반응', '수직으로 파여요', THEME.plasma],
        ];
        cols.forEach(([a, b, col], i) => {
          const cx = r.x + r.w * (0.27 + i * 0.46);
          text(c, a, cx, r.y + 62, 36, THEME.ink, { weight: 750, align: 'center' });
          text(c, b, cx, r.y + r.h - 40, 27, col, { weight: 650, align: 'center' });
        });
        c.strokeStyle = THEME.line;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(r.x + r.w / 2, r.y + 36);
        c.lineTo(r.x + r.w / 2, r.y + r.h - 36);
        c.stroke();
      },
    },
    {
      id: 'ccp_icp',
      eyebrow: PART_NAME[1],
      title: ['플라즈마를 만드는', '두 가지 방법'],
      lead: '둘 다 일반물리에서 배운 원리예요. 축전기의 전기장으로 만들면 CCP, 코일의 전자기 유도로 만들면 ICP.',
      accent: THEME.plasma,
      cards: [
        { k: 'CCP · 축전기형', t: '전기장으로 흔든다', d: '마주 본 두 판 사이 전기장이 전자를 위아래로 흔들어요' },
        { k: 'ICP · 코일형', t: '유도 전기장으로 돌린다', d: '코일 전류 → 변하는 자기장 → 맴도는 전기장 (패러데이 법칙)' },
        { k: '왜 ICP를 쓸까', t: '따로 조절한다', d: "플라즈마의 '양'과 이온을 당기는 '세기'를 나눠서 조절해요" },
      ],
      key: 'Capacitively / Inductively Coupled Plasma. 축전기처럼 / 코일처럼 에너지를 전달한다는 뜻이에요.',
      hero: (c, r) => {
        const cols: Array<[string, string]> = [
          ['CCP', '평행한 두 판 · 전기장'],
          ['ICP', '코일 · 전자기 유도'],
        ];
        cols.forEach(([a, b], i) => {
          const cx = r.x + r.w * (0.27 + i * 0.46);
          text(c, a, cx, r.y + 78, 58, THEME.ink, { weight: 800, align: 'center', track: 2 });
          text(c, b, cx, r.y + r.h - 40, 27, THEME.dim, { weight: 600, align: 'center' });
        });
        c.strokeStyle = THEME.line;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(r.x + r.w / 2, r.y + 36);
        c.lineTo(r.x + r.w / 2, r.y + r.h - 36);
        c.stroke();
      },
    },
    {
      id: 'plasma_basics',
      eyebrow: PART_NAME[2],
      title: ['이 연구의 장비', 'ICP-RIE 속으로'],
      lead: '위의 코일이 플라즈마를 만들고, 아래 전극이 이온을 끌어당겨요. 손잡이가 두 개인 셈이에요.',
      accent: THEME.cold,
      cards: [
        { k: '위 코일 · ICP', t: `${fmt(cont.icp_power_w)} W`, d: "알갱이를 얼마나 '많이' 만들지 정해요" },
        { k: '아래 전극 · RIE', t: `${cont.rie_power_w} W`, d: "이온을 얼마나 '세게' 당길지 정해요" },
        { k: '가스와 압력', t: `${cont.gas} ${cont.gas_sccm} sccm`, d: `염화수소를 조금씩 흘리고 ${cont.working_pressure_mTorr} mTorr로 유지해요` },
      ],
      key: '거의 진공인 이유: 알갱이가 서로 부딪히지 않고 기판까지 똑바로 날아가야 해요.',
    },
    {
      id: 'heat_path',
      eyebrow: PART_NAME[2],
      title: ['열은 어디로', '빠져나갈까?'],
      lead: '이온이 때릴 때마다 운동 에너지가 열로 바뀌어요. 진공 속이라 공기로는 식지 않고, 아래 차가운 받침대로만 빠져나가요.',
      accent: THEME.heat,
      cards: [
        { k: '열에도 옴의 법칙', t: '온도 차 = 열 × 저항', d: '전압 차 = 전류 × 저항과 꼴이 같아요' },
        { k: '뒷면 헬륨', t: `He ${cont.he_backside_pressure_torr} Torr`, d: '시편 뒤 얇은 틈에 헬륨을 채워 열이 건너갈 다리를 놓아요' },
        { k: '냉각기 · 칠러', t: `설정 ${set}°C`, d: "받침대 속을 도는 냉매에 '맞춰 둔' 온도예요" },
      ],
      key: '길 중간에 저항이 있으면, 받침대가 차가워도 시편은 뜨거울 수 있어요.',
      hero: (c, r) => {
        const x = r.x + r.w * 0.8;
        const y0 = r.y + 78;
        const y1 = r.y + r.h - 96;
        const nodes: Array<[string, string, string]> = [
          ['시편', '뜨거움', THEME.heat],
          ['받침대', '', THEME.slate],
          ['냉매', `설정 ${set}°C`, THEME.cold],
        ];
        const step = (y1 - y0) / (nodes.length - 1);
        for (let i = 0; i < nodes.length - 1; i++) zigzag(c, x, y0 + step * i + 16, y0 + step * (i + 1) - 16, i === 0 ? THEME.gold : THEME.faint);
        nodes.forEach(([name, sub, col], i) => {
          const y = y0 + step * i;
          c.beginPath();
          c.arc(x, y, 13, 0, Math.PI * 2);
          c.fillStyle = col;
          c.fill();
          text(c, name, x - 34, y + 10, 30, THEME.ink, { weight: 700, align: 'right' });
          if (sub) text(c, sub, x + 34, y + 9, 24, col, { weight: 600 });
        });
        text(c, '틈 = 열 저항', x + 34, y0 + step / 2 + 9, 24, THEME.gold, { weight: 600 });
        text(c, '전기 회로처럼 그리면', x, r.y + r.h - 34, 23, THEME.faint, { weight: 600, align: 'center' });
      },
    },
    {
      id: 'continuous_heat',
      eyebrow: PART_NAME[3],
      title: [`설정은 ${set}°C,`, `시편은 ${cont.sample_final_c}°C`],
      lead: `플라즈마를 ${cont.plasma_on_duration_s}초 동안 계속 켜고 온도를 쟀어요. 시편도, 시편을 올려 둔 홀더도 계속 뜨거워졌어요.`,
      accent: THEME.heat,
      cards: [
        { k: 'SiC 시편', t: `+${cont.sample_delta_c}°C`, d: `${cont.sample_initial_c}°C에서 ${cont.sample_final_c}°C로 올랐어요` },
        { k: '홀더', t: `+${cont.holder_delta_c}°C`, d: `${cont.holder_initial_c}°C에서 ${cont.holder_final_c}°C로 올랐어요` },
        { k: '조건', t: `ICP/RIE ${cont.icp_power_w}/${cont.rie_power_w} W`, d: `${cont.gas} ${cont.gas_sccm} sccm · ${cont.working_pressure_mTorr} mTorr · He ${cont.he_backside_pressure_torr} Torr` },
      ],
      key: "'맞춰 둔 온도'와 '실제로 잰 온도'는 서로 다른 값이에요.",
      hero: (c, r) => {
        const x = r.x + r.w * 0.5;
        pill(c, `칠러 설정 ${set}°C`, x, r.y + 56, 25, THEME.cold, alpha(THEME.cold, 0.13), { stroke: alpha(THEME.cold, 0.4) });
        text(c, 'SiC 시편', x, r.y + 190, 29, THEME.dim, { weight: 650 });
        let w = text(c, `${cont.sample_initial_c}`, x, r.y + 304, 60, THEME.faint, { weight: 700 });
        w += text(c, '→', x + w + 16, r.y + 298, 46, THEME.faint, { weight: 500 }) + 32;
        const w2 = text(c, `${cont.sample_final_c}`, x + w, r.y + 312, 150, THEME.heat, { weight: 800, track: -5 });
        text(c, '°C', x + w + w2 + 8, r.y + 312, 54, THEME.heat, { weight: 700 });
        text(c, '홀더', x, r.y + 410, 29, THEME.dim, { weight: 650 });
        w = text(c, `${cont.holder_initial_c}`, x, r.y + 494, 48, THEME.faint, { weight: 700 });
        w += text(c, '→', x + w + 14, r.y + 490, 38, THEME.faint, { weight: 500 }) + 28;
        const w3 = text(c, `${cont.holder_final_c}`, x + w, r.y + 500, 96, THEME.gold, { weight: 800, track: -3 });
        text(c, '°C', x + w + w3 + 8, r.y + 500, 40, THEME.gold, { weight: 700 });
        text(c, `플라즈마 ON ${cont.plasma_on_duration_s}초 뒤`, x, r.y + r.h - 50, 25, THEME.faint, { weight: 600 });
      },
    },
    {
      id: 'cyclic_cooling',
      eyebrow: PART_NAME[3],
      title: [`${cyc.pulse_duration_s}초 깎고,`, `${cyc.cooling_duration_s / 60}분 쉬면?`],
      lead: '한 번에 오래 켜지 않고 짧게 끊어서 깎았어요. 쉬는 동안 열이 받침대 쪽으로 빠져나가요.',
      accent: THEME.cold,
      cards: [
        { k: '깎을 때', t: `+${Math.min(...up)}~${Math.max(...up)}°C`, d: `${cyc.pulse_duration_s}초 플라즈마마다 오른 온도` },
        { k: '쉴 때', t: `−${Math.min(...down)}~${Math.max(...down)}°C`, d: `${cyc.cooling_duration_s / 60}분 쉬는 동안 내려간 온도` },
        { k: '쉬고 난 온도', t: `${seq[0]} → ${seq[2]} → ${seq[4]}°C`, d: '처음 온도로 완전히 돌아가지는 않았어요' },
      ],
      key: '끊어서 깎으면 열이 빠져나갈 시간을 벌 수 있어요.',
      hero: (c, r) => {
        text(c, '시편 온도 °C', r.x + 44, r.y + 56, 23, THEME.faint, { weight: 600, track: 1 });
        let x = r.x + r.w - 44;
        for (const [name, col] of [
          ['쉰 직후', THEME.cold],
          ['깎은 직후', THEME.heat],
        ] as Array<[string, string]>) {
          x -= text(c, name, x, r.y + 56, 24, THEME.dim, { weight: 600, align: 'right' });
          c.beginPath();
          c.arc(x - 20, r.y + 48, 9, 0, Math.PI * 2);
          c.fillStyle = col;
          c.fill();
          x -= 58;
        }
      },
    },
    {
      id: 'etch_rates',
      eyebrow: PART_NAME[3],
      title: ['차가울수록', '빨리 깎일까?'],
      lead: `칠러를 ${er.conditions.map((x: any) => fmt(x.chiller_setpoint_c)).join(', ')}°C로 바꿔 가며 SiC가 1분에 몇 nm 깎이는지 쟀어요. 결과는 순서대로가 아니었어요.`,
      accent: THEME.plasma,
      cards: [
        { k: '미리 알기', t: 'self-bias', d: '가벼운 전자가 전극에 먼저 쌓여 저절로 생기는 전압. 이온을 당기는 세기예요' },
        { k: '함께 달랐던 것', t: `${biases.join(' / ')} V`, d: `self-bias도, 120초 뒤 시편 온도(${temps.join(' / ')}°C)도 서로 달랐어요` },
        { k: '그래서', t: '단정할 수 없다', d: '칠러 온도 하나 때문이라고 말할 수 없어요' },
      ],
      key: `가장 느렸던 ${fmt(er.conditions[1].chiller_setpoint_c)}°C 조건은 self-bias가 가장 낮고, 시편은 가장 뜨거웠어요.`,
      hero: (c) => {
        const s = chartFrame(c, 'SiC 식각 속도 nm/min');
        er.conditions.forEach((cond: any, i: number) => {
          const cx = barU(CHART, i, 3) * W;
          axisLabel(c, cx, s.y + s.h + 52, `칠러 ${fmt(cond.chiller_setpoint_c)}°C`, [`self-bias ${cond.self_bias_v} V`, `시편 ${cond.sample_temp_at_120s_c}°C`]);
        });
      },
    },
    {
      id: 'supports',
      eyebrow: PART_NAME[3],
      title: ['받침을 바꾸면', '온도가 달라진다'],
      lead: `시편을 어디에 올리느냐에 따라 열이 빠져나가는 길이 달라져요. ${mt.duration_s}초 뒤 시편 온도를 네 가지 받침에서 비교했어요.`,
      accent: THEME.gold,
      cards: [
        { k: '미리 알기', t: '진공 그리스', d: '틈을 메워 열이 잘 건너가게 해 주는 재료예요' },
        { k: 'Al 판끼리 비교', t: `${mt.conditions[2].sample_c} → ${mt.conditions[3].sample_c}°C`, d: `같은 ${mt.conditions[3].self_bias_v} V에서 그리스를 바른 쪽이 조금 낮았어요` },
        { k: '주의', t: `${mBias.join(' / ')} V`, d: '전압이 서로 달라서 받침만의 효과라고 단정하긴 일러요' },
      ],
      key: "열이 건너가는 '접촉면'이 시편 온도를 좌우해요.",
      hero: (c) => {
        const s = chartFrame(c, `${mt.duration_s}초 뒤 시편 온도 °C`);
        mt.conditions.forEach((cond: any, i: number) => {
          const cx = barU(CHART, i, 4) * W;
          axisLabel(c, cx, s.y + s.h + 52, MOUNT[i], [`홀더 ${cond.holder_c}°C`, `${cond.self_bias_v} V`]);
        });
      },
    },
    {
      id: 'cu_profiles',
      eyebrow: PART_NAME[3],
      title: ['구리 시편의', '표면은 어땠을까?'],
      lead: '구리(Cu) 무늬 시편을 플라즈마로 처리한 뒤, 감광막(PR)을 벗겼을 때와 묽은 염산으로 씻었을 때의 표면 단차를 쟀어요.',
      accent: THEME.mint,
      cards: [
        { k: '미리 알기', t: '단차', d: '표면의 높은 곳과 낮은 곳의 높이 차이. 바늘로 표면을 훑어서 재요 (Alpha-Step)' },
        { k: '단위', t: 'Å · 옹스트롬', d: '1 Å은 0.1 nm예요. 원자 하나 크기쯤이에요' },
        { k: '주의', t: '깎인 깊이가 아니다', d: '구리가 깎인 두께나 식각 속도를 뜻하지 않아요' },
      ],
      key: `씻는 약품: ${cu.solution.replace('DI water', '초순수').replace('HCl', '염산')}`,
      hero: (c, r) => {
        const s = chartFrame(c, '표면 단차 Å');
        let x = r.x + r.w - 44;
        for (const [name, col] of [
          ['묽은 염산 처리 뒤', THEME.mint],
          ['PR 벗긴 뒤', '#7C879E'],
        ] as Array<[string, string]>) {
          x -= text(c, name, x, r.y + 56, 24, THEME.dim, { weight: 600, align: 'right' });
          rr(c, x - 30, r.y + 38, 20, 20, 5);
          c.fillStyle = col;
          c.fill();
          x -= 60;
        }
        cu.comparisons.forEach((cmp: any, i: number) => {
          const cx = barU(CHART, i, 3) * W;
          axisLabel(c, cx, s.y + s.h + 52, `시편 ${cmp.sample}`, [`${fmt(cmp.after_pr_strip_angstrom)} → ${fmt(cmp.after_di_hcl_angstrom)} Å`]);
        });
      },
    },
    {
      id: 'mo_reference',
      eyebrow: PART_NAME[3],
      title: ['참고 실험:', '몰리브덴(Mo)'],
      lead: `두께 ${mo.mo_nominal_thickness_nm} nm 몰리브덴 시편을 ${mo.pulse_duration_s}초씩 ${mo.pulse_count}번, 합쳐서 ${mo.cumulative_plasma_on_s}초 동안 플라즈마로 깎았어요.`,
      accent: THEME.slate,
      cards: [
        { k: '미리 알기', t: 'ECR 플라즈마', d: '마이크로파와 자석으로 전자를 공명시켜 플라즈마를 만드는 또 다른 방식이에요' },
        { k: '조건', t: `ECR/RIE ${mo.ecr_power_w}/${mo.rie_power_w} W`, d: `칠러 설정 ${fmt(mo.chiller_setpoint_c)}°C · self-bias ${mo.self_bias_v} V` },
        { k: '주의', t: '층 그림은 개념도', d: '모든 시편이 실제로 Mo/Cu/Mo로 쌓여 있다는 뜻은 아니에요' },
      ],
      key: '다른 실험들과 따로 한 측정이에요. SiC 결과와 섞어서 비교하지 않아요.',
      hero: (c, r) => {
        const x = r.x + r.w * 0.56;
        text(c, 'Mo 식각 속도', x, r.y + 150, 29, THEME.dim, { weight: 650 });
        const w0 = text(c, '약', x, r.y + 330, 48, THEME.faint, { weight: 650 });
        const w = text(c, `${mo.approx_etch_rate_nm_per_min}`, x + w0 + 18, r.y + 340, 200, THEME.ink, { weight: 800, track: -8 });
        text(c, 'nm/min', x + w0 + w + 34, r.y + 338, 44, THEME.dim, { weight: 650 });
        pill(c, `${mo.pulse_duration_s}초 × ${mo.pulse_count}번 = ${mo.cumulative_plasma_on_s}초`, x, r.y + 400, 26, THEME.ink, 'rgba(255,255,255,0.07)', { stroke: THEME.line });
        text(c, '개념도', r.x + r.w * 0.28, r.y + r.h - 40, 24, THEME.faint, { weight: 600, align: 'center' });
      },
    },
    {
      id: 'conclusion',
      eyebrow: 'CONCLUSIONS',
      title: ['그래서,', '무엇을 알아냈나'],
      lead: '숫자 세 묶음으로 정리하면 이래요.',
      accent: THEME.gold,
      cards: [
        { k: '기억할 것', t: '설정 ≠ 실제', d: '장비에 맞춘 온도가 곧 시편의 온도는 아니에요' },
        { k: '다음 질문', t: '열을 어떻게 뺄까', d: '끊어서 깎기, 받침과 접촉면이 실마리예요' },
        { k: '더 궁금하면', t: '아래 채팅으로', d: '발표자 PC의 AI가 포스터 자료를 바탕으로 답해요' },
      ],
      key: '설정 온도만 믿지 말고, 실제 시편 온도를 재야 해요.',
      hero: (c, r) => {
        const rows: Array<[string, string, string]> = [
          [`${set} → ${cont.sample_final_c}°C`, `칠러를 ${set}°C로 맞춰도, 플라즈마 ${cont.plasma_on_duration_s}초 뒤 시편은 ${cont.sample_final_c}°C`, THEME.heat],
          [`−${Math.min(...down)}~${Math.max(...down)}°C`, `${cyc.pulse_duration_s}초 깎고 ${cyc.cooling_duration_s / 60}분 쉬면 그만큼 되돌아와요`, THEME.cold],
          [`${rates.join(' / ')}`, 'SiC 식각 속도 nm/min. 온도와 self-bias가 함께 달랐어요', THEME.plasma],
        ];
        const rowH = (r.h - 60) / 3;
        rows.forEach(([big, sub, col], i) => {
          const y = r.y + 30 + rowH * i;
          if (i) {
            c.strokeStyle = THEME.line;
            c.lineWidth = 2;
            c.beginPath();
            c.moveTo(r.x + 48, y);
            c.lineTo(r.x + r.w - 48, y);
            c.stroke();
          }
          text(c, `0${i + 1}`, r.x + 50, y + 62, 25, col, { weight: 700, track: 2 });
          text(c, big, r.x + 50, y + 152, 92, col, { weight: 800, track: -3 });
          text(c, sub, r.x + 50, y + 206, 28, THEME.dim, { weight: 550 });
        });
      },
    },
  ];
}

let pagesCache: PageDef[] | null = null;
const pages = (): PageDef[] => (pagesCache ??= buildPages());
export const pageAccent = (id: string): string => pages().find((p) => p.id === id)?.accent ?? THEME.cold;

/* ───────────────────────── 그리기 ───────────────────────── */

function drawPage(c: Ctx, index: number): void {
  const list = pages();
  const p = list[index];
  const ac = p.accent;

  // 바탕: 거의 검은 남색 + 은은한 빛 번짐 + 점 격자
  const bg = c.createLinearGradient(0, 0, 0, HH);
  bg.addColorStop(0, THEME.bg1);
  bg.addColorStop(0.45, THEME.bg0);
  bg.addColorStop(1, '#080C18');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, HH);
  glow(c, W * 0.92, HH * 0.04, 760, ac, 0.2);
  glow(c, W * 0.1, HH * 0.47, 620, ac, 0.07);
  c.fillStyle = 'rgba(255,255,255,0.045)';
  for (let y = 26; y < HH; y += 44) for (let x = 26; x < W; x += 44) c.fillRect(x, y, 2, 2);

  // 머리줄
  const top = px(PAGE.top);
  text(c, '반도체물리학부 학술제', top.x, top.y + 34, 24, THEME.dim, { weight: 650, track: 0.5 });
  text(c, `${String(index + 1).padStart(2, '0')} / ${String(list.length).padStart(2, '0')}`, top.x + top.w, top.y + 34, 24, THEME.faint, { weight: 650, align: 'right', track: 1.5 });
  c.fillStyle = THEME.line;
  c.fillRect(top.x, top.y + top.h + 2, top.w, 2);

  // 제목
  const t = px(PAGE.title);
  text(c, p.eyebrow, t.x + 2, t.y + 54, 25, ac, { weight: 750, track: 3.5 });
  text(c, p.title[0], t.x - 3, t.y + 158, 92, THEME.ink, { weight: 800, track: -3 });
  setFont(c, 92, { weight: 800, track: -3 });
  const tw = c.measureText(p.title[1]).width;
  const tg = c.createLinearGradient(t.x, 0, t.x + tw, 0);
  tg.addColorStop(0, '#FFFFFF');
  tg.addColorStop(1, ac);
  text(c, p.title[1], t.x - 3, t.y + 264, 92, tg, { weight: 800, track: -3 });

  const l = px(PAGE.lead);
  wrap(c, p.lead, l.x, l.y + 42, l.w, 49, 33, THEME.dim, { weight: 500, maxLines: 3 });

  // 3D 시뮬이 서는 무대
  const h = px(PAGE.hero);
  if (!dry) {
    c.save();
    rr(c, h.x, h.y, h.w, h.h, 40);
    c.clip();
    c.fillStyle = 'rgba(255,255,255,0.028)';
    c.fillRect(h.x, h.y, h.w, h.h);
    glow(c, h.x + h.w / 2, h.y + h.h * 0.62, h.w * 0.62, ac, 0.13);
    c.restore();
    rr(c, h.x, h.y, h.w, h.h, 40);
    c.strokeStyle = THEME.line;
    c.lineWidth = 2;
    c.stroke();
  }
  p.hero?.(c, h, ac);

  // 개념 카드
  const cr = px(PAGE.cards);
  const gap = 22;
  const cw = (cr.w - gap * (p.cards.length - 1)) / p.cards.length;
  p.cards.forEach((cd, i) => {
    const x = cr.x + i * (cw + gap);
    if (!dry) {
      rr(c, x, cr.y, cw, cr.h, 30);
      c.fillStyle = THEME.panel;
      c.fill();
      c.strokeStyle = THEME.line;
      c.lineWidth = 2;
      c.stroke();
      c.fillStyle = ac;
      rr(c, x + 30, cr.y + 34, 34, 5, 3);
      c.fill();
    }
    text(c, cd.k, x + 30, cr.y + 82, 24, ac, { weight: 700, track: 1 });
    // 큰 글자는 카드 폭에 맞춰 줄인다
    let size = 42;
    setFont(c, size, { weight: 780, track: -1 });
    const need = c.measureText(cd.t).width;
    if (need > cw - 60) size = Math.max(26, Math.floor((size * (cw - 60)) / need));
    text(c, cd.t, x + 30, cr.y + 144, size, THEME.ink, { weight: 780, track: -1 });
    wrap(c, cd.d, x + 30, cr.y + 198, cw - 56, 40, 28, THEME.dim, { weight: 500, maxLines: 4 });
  });

  // 한 줄 정리
  const k = px(PAGE.key);
  if (!dry) {
    rr(c, k.x, k.y, k.w, k.h, 24);
    c.fillStyle = alpha(ac, 0.1);
    c.fill();
    rr(c, k.x, k.y, 8, k.h, 4);
    c.fillStyle = ac;
    c.fill();
  }
  setFont(c, 28, { weight: 650 });
  const one = c.measureText(p.key).width <= k.w - 70;
  wrap(c, p.key, k.x + 38, k.y + (one ? k.h / 2 + 10 : 50), k.w - 70, 40, 28, THEME.ink, { weight: 650, maxLines: 2 });

  // 진행 표시: 장면 수만큼 칸, PART 사이는 조금 띄운다
  if (!dry) {
    const pr = px(PAGE.progress);
    const parts = sceneScripts.map((s) => s.part);
    const breaks = parts.filter((v, i) => i > 0 && v !== parts[i - 1]).length;
    const g = 8;
    const bg2 = 18;
    const sw = (pr.w - g * (list.length - 1) - bg2 * breaks) / list.length;
    let x = pr.x;
    list.forEach((_, i) => {
      if (i > 0) x += g + (parts[i] !== parts[i - 1] ? bg2 : 0);
      rr(c, x, pr.y, sw, 8, 4);
      c.fillStyle = i === index ? ac : i < index ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.13)';
      c.fill();
      x += sw;
    });
  }
}

export function paintPage(canvas: HTMLCanvasElement, index: number): void {
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== HH) canvas.height = HH;
  const c = canvas.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  drawPage(c, Math.max(0, Math.min(pages().length - 1, index)));
}

/** 슬라이드와 3D 이름표에 쓰는 글자를 전부 모아 글꼴을 미리 받아 둔다. */
export async function loadPosterFonts(): Promise<void> {
  if (!('fonts' in document)) return;
  const scratch = document.createElement('canvas');
  scratch.width = scratch.height = 8;
  const c = scratch.getContext('2d')!;
  dry = true;
  try {
    for (let i = 0; i < pages().length; i++) drawPage(c, i);
  } finally {
    dry = false;
  }
  const sample = [...new Set([...USED].join('') + '0123456789.,−+→°C%≈·/')].join('');
  try {
    await Promise.race([Promise.all([500, 800].map((w) => document.fonts.load(`${w} 40px 'Pretendard Variable'`, sample))), new Promise((r) => setTimeout(r, 4000))]);
  } catch {
    /* 글꼴을 못 받아도 시스템 글꼴로 그린다 */
  }
}

export { subRect };
