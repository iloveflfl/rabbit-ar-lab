/**
 * 슬라이드의 HERO 자리에 서는 3D 시뮬레이션과 그래프.
 * (3D 는 장비·기판·입자·그래프에만 쓴다. 안내 토끼는 rabbit/ 의 2D 리그다.)
 * 측정값은 전부 poster_facts.json 에서 온다. 입자의 움직임은 원리를 보여 주는 연출이지 측정 데이터가 아니다.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CHART, H, PAGE, type UvRect, Z, barU, rectCenter, rectSize, subRect } from '../ar/sceneLayout';
import { type Motion, clamp01, ease, smoothstep } from '../motion/tween';
import { Label } from './labels';
import { THEME, fact, fmt } from './posterArt';

export interface Prop {
  readonly group: THREE.Group;
  /** 슬라이드가 열릴 때(또는 다시 누를 때) 처음부터 재생한다 */
  play(motion: Motion): void;
  update?(dt: number, time: number): void;
}

function popLabel(motion: Motion, label: Label, delay: number): void {
  label.pop = 0;
  motion.run(0.42, (k) => (label.pop = k), { delay, ease: ease.outBack });
}

const std = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.05, ...extra });

/** 슬롯 중심에 놓인 그룹과 슬롯 크기 */
function slotGroup(slot: UvRect): { group: THREE.Group; w: number; h: number; cx: number; cy: number } {
  const [cx, cy] = rectCenter(slot);
  const [w, h] = rectSize(slot);
  const group = new THREE.Group();
  group.position.set(cx, cy, Z.chartBase);
  return { group, w, h, cx, cy };
}

let dotTexture: THREE.CanvasTexture | null = null;
/** 부드러운 흰 점 (입자용) */
function dotTex(): THREE.CanvasTexture {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return (dotTexture = new THREE.CanvasTexture(c));
}

/** 빛나는 입자 묶음 */
function particles(count: number, color: string, size: number, vertexColors = false): { points: THREE.Points; pos: Float32Array; col: Float32Array | null } {
  const pos = new Float32Array(count * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  let col: Float32Array | null = null;
  if (vertexColors) {
    col = new Float32Array(count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const mat = new THREE.PointsMaterial({ map: dotTex(), color, size, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, vertexColors });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 22;
  return { points, pos, col };
}
const touch = (p: THREE.Points, name = 'position') => ((p.geometry.attributes[name] as THREE.BufferAttribute).needsUpdate = true);
/** 0..1 의 고정 난수 (같은 i 면 항상 같은 값) */
const rnd = (i: number, salt = 0) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const GLOW_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
uniform vec3 uA;
uniform vec3 uB;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 p = vUv - 0.5;
  float n = noise(vec2(p.x * 5.0 + uTime * 0.5, p.y * 4.0 - uTime * 0.9)) * 0.6 + noise(p * 11.0 + uTime * 0.7) * 0.4;
  float body = smoothstep(0.5, 0.0, length(p));
  float a = body * (0.45 + 0.7 * n) * uPower;
  vec3 col = mix(uA, uB, n);
  col = mix(col, vec3(1.0), body * body * 0.4);
  gl_FragColor = vec4(col * a, a);
}`;

/** 일렁이는 플라즈마 빛 한 장 */
function plasmaGlow(w: number, h: number, a = '#7B5CFF', b = '#FF86DC'): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 1 }, uA: { value: new THREE.Color(a) }, uB: { value: new THREE.Color(b) } },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.renderOrder = 20;
  return { mesh, mat };
}

const tag = (text: string, size: number, color: string = THEME.ink, bg?: string) => new Label(text, { size, color, bg, display: false, weight: 700 });

/* ───────────────────────── 막대 그래프 ───────────────────────── */

export interface BarSpec {
  /** 포스터 u 좌표(막대 중심) */
  u: number;
  value: number;
  color: string;
  label: string;
  labelColor?: string;
}

export class BarChart implements Prop {
  readonly group: THREE.Group;
  private readonly bars: Array<{ mesh: THREE.Mesh; label: Label; height: number }> = [];

  constructor(slot: UvRect, specs: BarSpec[], max: number, barWidth: number, labelSize: number) {
    const s = slotGroup(slot);
    this.group = s.group;
    const usable = s.h * 0.86;
    const depth = Math.min(0.07, barWidth * 0.75);
    const baseY = -s.h / 2 + 0.003;
    for (const spec of specs) {
      const geo = new RoundedBoxGeometry(barWidth, 1, depth, 3, Math.min(barWidth, depth) * 0.14);
      geo.translate(0, 0.5, depth / 2);
      const mesh = new THREE.Mesh(geo, std(spec.color, { emissive: spec.color, emissiveIntensity: 0.28, roughness: 0.3 }));
      const height = Math.max(0.006, (spec.value / max) * usable);
      mesh.position.set(spec.u - 0.5 - s.cx, baseY, 0.002);
      mesh.scale.y = height;
      this.group.add(mesh);
      const label = new Label(spec.label, { size: labelSize, color: spec.labelColor ?? THEME.ink });
      label.mesh.position.set(mesh.position.x, baseY + height + labelSize * 0.9, depth + 0.004);
      this.group.add(label.mesh);
      this.bars.push({ mesh, label, height });
    }
  }

  play(motion: Motion): void {
    this.bars.forEach((b, i) => {
      motion.kill(b.mesh.scale);
      b.mesh.scale.y = 0.0005;
      motion.to(b.mesh.scale, { y: b.height }, 0.9, { delay: 0.15 + i * 0.13, ease: ease.outBack });
      popLabel(motion, b.label, 0.65 + i * 0.13);
    });
  }
}

/* ───────────────────────── 온도계 (연속 플라즈마) ───────────────────────── */

class Thermometer {
  readonly group = new THREE.Group();
  private readonly fill: THREE.Mesh;
  private readonly fillMat: THREE.MeshStandardMaterial;
  readonly value: Label;
  private readonly tubeH: number;
  private readonly cold = new THREE.Color(THEME.cold);
  private readonly hot: THREE.Color;

  constructor(h: number, name: string, hot: string, private readonly range: [number, number]) {
    this.hot = new THREE.Color(hot);
    const r = h * 0.07;
    this.tubeH = h * 0.64;
    const bulbY = -h / 2 + r * 1.9;
    const glass = new THREE.MeshStandardMaterial({ color: '#DCEBFF', transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.2, depthWrite: false });
    const tube = new THREE.Mesh(new THREE.CapsuleGeometry(r, this.tubeH, 6, 20), glass);
    tube.position.y = bulbY + this.tubeH / 2 + r * 0.6;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(r * 1.75, 24, 16), glass);
    bulb.position.y = bulbY;
    this.fillMat = std(THEME.cold, { emissive: '#000000', roughness: 0.3 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(r * 1.32, 20, 14), this.fillMat);
    core.position.y = bulbY;
    const fillGeo = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 1, 16);
    fillGeo.translate(0, 0.5, 0);
    this.fill = new THREE.Mesh(fillGeo, this.fillMat);
    this.fill.position.y = bulbY + r * 0.8;
    this.group.add(core, this.fill, tube, bulb);
    tube.renderOrder = 12;
    bulb.renderOrder = 12;

    const nameLabel = tag(name, h * 0.075, THEME.dim);
    nameLabel.mesh.position.set(0, h / 2 + h * 0.01, r);
    this.value = new Label('', { size: h * 0.1, color: '#0B0F1A', bg: hot });
    this.value.mesh.position.set(r * 4.4, 0, r * 1.5);
    this.group.add(nameLabel.mesh, this.value.mesh);
    this.setLevel(0);
  }

  /** k: 0 = 시작 온도, 1 = 끝 온도 (표시 범위 0~110°C 기준 높이) */
  setLevel(k: number): void {
    const t = this.range[0] + (this.range[1] - this.range[0]) * k;
    const frac = Math.max(0.03, Math.min(1, t / 110));
    this.fill.scale.y = this.tubeH * frac;
    this.fillMat.color.copy(this.cold).lerp(this.hot, k);
    this.fillMat.emissive.copy(this.hot).multiplyScalar(0.5 * k);
    this.value.mesh.position.y = this.fill.position.y + this.fill.scale.y;
  }
}

export class ThermoPair implements Prop {
  readonly group: THREE.Group;
  private readonly a: Thermometer;
  private readonly b: Thermometer;
  private readonly f = fact('sic_continuous_minus50');
  private progress = { k: 1 };

  constructor() {
    const s = slotGroup(subRect(PAGE.hero, 0.05, 0.16, 0.47, 0.94));
    this.group = s.group;
    const f = this.f;
    this.a = new Thermometer(s.h * 0.86, 'SiC 시편', THEME.heat, [f.sample_initial_c, f.sample_final_c]);
    this.b = new Thermometer(s.h * 0.86, '홀더', THEME.gold, [f.holder_initial_c, f.holder_final_c]);
    this.a.group.position.set(-s.w * 0.3, -s.h * 0.04, 0.04);
    this.b.group.position.set(s.w * 0.16, -s.h * 0.04, 0.04);
    this.a.value.mesh.position.x *= -1; // 시편 값은 왼쪽에: 옆 온도계를 가리지 않게
    this.group.add(this.a.group, this.b.group);
    this.apply(1);
  }

  /** 끝점 두 개만 수치가 있으므로, 숫자 표시는 시작값과 끝값만 보여 준다(중간값을 지어내지 않는다). */
  private apply(k: number): void {
    const f = this.f;
    this.a.setLevel(k);
    this.b.setLevel(k);
    const end = k >= 0.999;
    this.a.value.setText(end ? `${f.sample_final_c}°C` : `${f.sample_initial_c}°C`);
    this.b.value.setText(end ? `${f.holder_final_c}°C` : `${f.holder_initial_c}°C`);
  }

  play(motion: Motion): void {
    motion.kill(this.progress);
    this.progress.k = 0;
    this.apply(0);
    motion.to(this.progress, { k: 1 }, 2.8, {
      delay: 0.6,
      ease: ease.inOutQuad,
      onUpdate: () => this.apply(this.progress.k),
      onComplete: () => {
        this.apply(1);
        popLabel(motion, this.a.value, 0);
        popLabel(motion, this.b.value, 0.12);
      },
    });
  }
}

/* ───────────────────────── 꺾은선 (30초 ON / 3분 냉각) ───────────────────────── */

export class CyclicChart implements Prop {
  readonly group: THREE.Group;
  private readonly points: Array<{ dot: THREE.Mesh; label: Label }> = [];
  private readonly segs: Array<{ mesh: THREE.Mesh; len: number }> = [];

  constructor() {
    const s = slotGroup(subRect(PAGE.hero, 0.05, 0.2, 0.95, 0.95));
    this.group = s.group;
    const seq = fact('sic_cyclic_minus50').sequence as Array<{ stage: string; sample_c: number }>;
    const names = ['시작', '깎기 1', '쉬기 1', '깎기 2', '쉬기 2', '깎기 3'];
    const max = 40;
    const x0 = -s.w * 0.42;
    const dx = (s.w * 0.84) / (seq.length - 1);
    const y0 = -s.h * 0.3;
    const usable = s.h * 0.66;
    const pos = seq.map((p, i) => {
      const hot = i % 2 === 1;
      // 뜨거운 점은 관람객 쪽으로 더 튀어나온다 → 시점을 옮기면 지그재그가 입체로 보인다.
      return new THREE.Vector3(x0 + dx * i, y0 + (p.sample_c / max) * usable, hot ? 0.1 : 0.03);
    });
    const r = s.h * 0.036;
    const hotMat = std(THEME.heat, { emissive: THEME.heat, emissiveIntensity: 0.55 });
    const coldMat = std(THEME.cold, { emissive: THEME.cold, emissiveIntensity: 0.5 });

    for (let i = 0; i < pos.length - 1; i++) {
      const a = pos[i];
      const b = pos[i + 1];
      const len = a.distanceTo(b);
      const geo = new THREE.CylinderGeometry(r * 0.34, r * 0.34, 1, 12);
      geo.translate(0, 0.5, 0);
      const mesh = new THREE.Mesh(geo, b.y > a.y ? hotMat : coldMat);
      mesh.position.copy(a);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      mesh.scale.y = len;
      this.group.add(mesh);
      this.segs.push({ mesh, len });
    }
    pos.forEach((p, i) => {
      const hot = i % 2 === 1;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), hot ? hotMat : coldMat);
      dot.position.copy(p);
      const label = new Label(`${seq[i].sample_c}`, { size: s.h * 0.11, color: hot ? THEME.heat : THEME.cold });
      label.mesh.position.set(p.x, p.y + (hot ? r * 3.1 : -r * 3.1), p.z + 0.004);
      const t = tag(names[i], s.h * 0.058, THEME.dim);
      t.mesh.position.set(p.x, -s.h / 2 + s.h * 0.05, 0.004);
      this.group.add(dot, label.mesh, t.mesh);
      this.points.push({ dot, label });
    });
  }

  play(motion: Motion): void {
    const step = 0.42;
    this.points.forEach((p, i) => {
      motion.kill(p.dot.scale);
      p.dot.scale.setScalar(0.001);
      motion.to(p.dot.scale, { x: 1, y: 1, z: 1 }, 0.4, { delay: 0.15 + i * step, ease: ease.outBack });
      popLabel(motion, p.label, 0.25 + i * step);
    });
    this.segs.forEach((sg, i) => {
      motion.kill(sg.mesh.scale);
      sg.mesh.scale.y = 0.0001;
      motion.to(sg.mesh.scale, { y: sg.len }, step, { delay: 0.2 + i * step, ease: ease.inOutQuad });
    });
  }
}

/* ───────────────────────── Mo/Cu/Mo 개념 적층 ───────────────────────── */

export class MoStack implements Prop {
  readonly group: THREE.Group;
  private readonly slabs: Array<{ mesh: THREE.Mesh; y: number }> = [];
  private readonly spin = new THREE.Group();

  constructor() {
    const s = slotGroup(subRect(PAGE.hero, 0.07, 0.22, 0.49, 0.84));
    this.group = s.group;
    this.group.add(this.spin);
    const w = s.w * 0.78;
    const d = 0.16;
    const layers: Array<[string, string, number]> = [
      ['Mo', '#8A93BA', s.h * 0.2],
      ['Cu', THEME.copper, s.h * 0.3],
      ['Mo', '#8A93BA', s.h * 0.2],
    ];
    let y = -s.h * 0.4;
    for (const [name, color, hh] of layers) {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, hh, d, 3, hh * 0.1), std(color, { metalness: 0.3, roughness: 0.28, emissive: color, emissiveIntensity: 0.12 }));
      const cy = y + hh / 2;
      mesh.position.set(0, cy, d / 2 + 0.004);
      const label = new Label(name, { size: hh * 0.5, color: '#0B0F1A' });
      label.mesh.position.set(0, 0, d / 2 + 0.003);
      mesh.add(label.mesh);
      this.spin.add(mesh);
      this.slabs.push({ mesh, y: cy });
      y += hh + s.h * 0.04;
    }
    this.spin.rotation.x = 0.22;
  }

  update(_dt: number, time: number): void {
    this.spin.rotation.y = Math.sin(time * 0.5) * 0.35;
  }

  play(motion: Motion): void {
    this.slabs.forEach((sl, i) => {
      motion.kill(sl.mesh.position);
      sl.mesh.position.y = sl.y + 0.2;
      sl.mesh.visible = false;
      motion.after(0.1 + i * 0.22, () => (sl.mesh.visible = true), sl.mesh.position);
      motion.to(sl.mesh.position, { y: sl.y }, 0.6, { delay: 0.1 + i * 0.22, ease: ease.outBounce });
    });
  }
}

/* ───────────────────────── 표지: 웨이퍼 ───────────────────────── */

export class WaferHero implements Prop {
  readonly group: THREE.Group;
  private readonly disc: THREE.Mesh;
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly setLabel: Label;
  private readonly realLabel: Label;
  private readonly heat = { k: 0 };
  private readonly cold = new THREE.Color('#3B8FD0');
  private readonly hot = new THREE.Color('#FF5A2C');

  constructor() {
    const s = slotGroup(PAGE.hero);
    this.group = s.group;
    const f = fact('sic_continuous_minus50');
    const r = s.h * 0.34;
    // 칩(다이) 무늬
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0C1222';
    g.fillRect(0, 0, 512, 512);
    const n = 13;
    const cell = 512 / n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = rnd(x * 17 + y, 3);
        g.fillStyle = `hsla(${200 + v * 90}, 80%, ${42 + rnd(x + y * 31, 5) * 26}%, ${0.5 + v * 0.4})`;
        g.fillRect(x * cell + 3, y * cell + 3, cell - 6, cell - 6);
        g.fillStyle = 'rgba(255,255,255,0.22)';
        g.fillRect(x * cell + 7, y * cell + 7, cell - 14, 3);
      }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = std('#FFFFFF', { map: tex, metalness: 0.3, roughness: 0.25, emissiveMap: tex, emissive: '#FFFFFF', emissiveIntensity: 0.5 });
    const edge = std('#2A3350', { metalness: 0.3, roughness: 0.3 });
    this.disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 0.035, 72), [edge, this.mat, edge]);
    this.disc.rotation.x = 1.08;
    this.disc.position.set(0, s.h * 0.04, 0.16);
    const halo = plasmaGlow(r * 3.4, r * 2.4, '#3F6BFF', '#9A6BFF');
    halo.mat.uniforms.uPower.value = 0.5;
    halo.mesh.position.set(0, s.h * 0.02, 0.02);
    this.halo = halo.mat;
    this.setLabel = new Label(`설정 ${fmt(f.chiller_setpoint_c)}°C`, { size: s.h * 0.075, color: '#06121F', bg: THEME.cold });
    this.setLabel.mesh.position.set(-s.w * 0.3, s.h * 0.36, 0.2);
    this.realLabel = new Label(`실제 ${f.sample_final_c}°C`, { size: s.h * 0.075, color: '#1F0A04', bg: THEME.heat });
    this.realLabel.mesh.position.set(s.w * 0.3, s.h * 0.36, 0.2);
    this.group.add(halo.mesh, this.disc, this.setLabel.mesh, this.realLabel.mesh);
  }
  private readonly halo: THREE.ShaderMaterial;

  update(_dt: number, time: number): void {
    this.disc.rotation.y = time * 0.35;
    this.disc.position.z = 0.16 + Math.sin(time * 0.9) * 0.012;
    this.halo.uniforms.uTime.value = time;
    this.mat.emissive.copy(this.cold).lerp(this.hot, this.heat.k);
    (this.halo.uniforms.uA.value as THREE.Color).set('#3F6BFF').lerp(this.hot, this.heat.k * 0.8);
  }

  play(motion: Motion): void {
    motion.kill(this.heat);
    this.heat.k = 0;
    popLabel(motion, this.setLabel, 0.3);
    this.realLabel.pop = 0;
    motion.to(this.heat, { k: 1 }, 2.4, { delay: 1.2, ease: ease.inOutSine });
    popLabel(motion, this.realLabel, 3.0);
  }
}

/* ───────────────────────── 쌓고 · 가리고 · 깎기 ───────────────────────── */

export class LithoStack implements Prop {
  readonly group: THREE.Group;
  private readonly tilt = new THREE.Group();
  private readonly film: THREE.Mesh[] = [];
  private readonly resist: THREE.Mesh[] = [];
  private readonly ions: ReturnType<typeof particles>;
  private readonly step: Label;
  private readonly bw: number;
  private readonly topY: number;
  private readonly fh: number;
  private readonly ph: number;
  private t = 0;
  private phase = -1;
  private static readonly STEPS = ['① 막을 쌓는다 (증착)', '② 감광막으로 덮는다', '③ 남길 무늬만 남긴다 (노광)', '④ 플라즈마로 깎는다 (식각)', '⑤ 감광막을 벗긴다', '무늬 완성'];

  constructor() {
    const s = slotGroup(PAGE.hero);
    this.group = s.group;
    this.group.add(this.tilt);
    const n = 9;
    const bw = (this.bw = s.w * 0.6);
    const d = 0.2;
    const baseH = s.h * 0.12;
    const fh = (this.fh = s.h * 0.11);
    const ph = (this.ph = s.h * 0.07);
    const base = new THREE.Mesh(new RoundedBoxGeometry(bw, baseH, d, 3, baseH * 0.12), std('#39456A', { metalness: 0.3, roughness: 0.35 }));
    const baseTop = -s.h * 0.2;
    base.position.set(0, baseTop - baseH / 2, 0);
    this.topY = baseTop;
    this.tilt.add(base);
    const sw = bw / n;
    for (let i = 0; i < n; i++) {
      const x = -bw / 2 + sw * (i + 0.5);
      const fg = new THREE.BoxGeometry(sw * 0.999, 1, d * 0.999);
      fg.translate(0, 0.5, 0);
      const film = new THREE.Mesh(fg, std('#39C6B4', { emissive: '#39C6B4', emissiveIntensity: 0.25, roughness: 0.3, metalness: 0.2 }));
      film.position.set(x, baseTop, 0);
      const pg = new THREE.BoxGeometry(sw * 0.999, 1, d * 0.999);
      pg.translate(0, 0.5, 0);
      const pr = new THREE.Mesh(pg, std(THEME.gold, { emissive: THEME.gold, emissiveIntensity: 0.2, roughness: 0.5 }));
      pr.position.set(x, baseTop + fh, 0);
      this.film.push(film);
      this.resist.push(pr);
      this.tilt.add(film, pr);
    }
    this.ions = particles(40, '#C9A8FF', s.h * 0.05);
    this.tilt.add(this.ions.points);
    this.tilt.rotation.x = 0.42;
    this.tilt.position.z = 0.14;
    this.step = new Label(LithoStack.STEPS[0], { size: s.h * 0.07, color: THEME.ink, bg: 'rgba(255,255,255,0.1)', display: false, weight: 700 });
    this.step.mesh.position.set(0, s.h * 0.36, 0.22);
    this.group.add(this.step.mesh);
    for (const t of LithoStack.STEPS) this.step.setText(t);
    this.step.setText(LithoStack.STEPS[0]);
  }

  update(dt: number, time: number): void {
    this.t = (this.t + dt) % 11.5;
    const t = this.t;
    this.tilt.rotation.y = Math.sin(time * 0.45) * 0.4;
    const k = (a: number, b: number) => smoothstep(a, b, t);
    const depo = k(0.3, 1.6);
    const coat = k(2.0, 3.0);
    const dev = k(3.6, 4.6);
    const etch = k(5.2, 7.2);
    const strip = k(7.8, 8.8);
    const phase = t < 2 ? 0 : t < 3.6 ? 1 : t < 5.2 ? 2 : t < 7.8 ? 3 : t < 9 ? 4 : 5;
    if (phase !== this.phase) {
      this.phase = phase;
      this.step.setText(LithoStack.STEPS[phase]);
    }
    this.film.forEach((m, i) => {
      const open = i % 2 === 1;
      m.scale.y = Math.max(0.0001, this.fh * depo * (open ? 1 - etch : 1));
      m.visible = m.scale.y > 0.0005;
      const pr = this.resist[i];
      pr.scale.y = Math.max(0.0001, this.ph * coat * (open ? 1 - dev : 1 - strip));
      pr.visible = pr.scale.y > 0.0005;
    });
    // 깎는 동안만 이온이 내려온다
    const on = etch > 0 && etch < 1 ? 1 : 0;
    const n = this.ions.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const kk = (time * (0.9 + rnd(i) * 0.6) + rnd(i, 1)) % 1;
      this.ions.pos[i * 3] = (rnd(i, 2) - 0.5) * this.bw;
      this.ions.pos[i * 3 + 1] = on ? this.topY + this.fh + 0.26 * (1 - kk * kk) : -99;
      this.ions.pos[i * 3 + 2] = (rnd(i, 3) - 0.5) * 0.18;
    }
    touch(this.ions.points);
  }

  play(): void {
    this.t = 0;
    this.phase = -1;
  }
}

/* ───────────────────────── 기체 → 플라즈마 ───────────────────────── */

export class Ionization implements Prop {
  readonly group: THREE.Group;
  private readonly atoms: THREE.InstancedMesh;
  private readonly electrons: ReturnType<typeof particles>;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly state: Label;
  private readonly n = 64;
  private readonly box: [number, number, number];
  private readonly m = new THREE.Matrix4();
  private readonly cGas = new THREE.Color('#8C97AE');
  private readonly cIon = new THREE.Color(THEME.plasma);
  private readonly c = new THREE.Color();
  private t = 0;
  private phase = -1;
  private static readonly NAMES = ['기체: 전자가 원자에 붙어 있다', '전기 에너지를 준다', '플라즈마: 전자와 이온이 따로 논다'];

  constructor() {
    const s = slotGroup(PAGE.hero);
    this.group = s.group;
    this.box = [s.w * 0.8, s.h * 0.5, 0.2];
    const r = s.h * 0.022;
    this.atoms = new THREE.InstancedMesh(new THREE.SphereGeometry(r, 16, 12), std('#FFFFFF', { roughness: 0.35, emissive: '#FFFFFF', emissiveIntensity: 0.18 }), this.n);
    this.atoms.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.atoms.frustumCulled = false;
    this.electrons = particles(this.n, THEME.cold, s.h * 0.04);
    const glow = plasmaGlow(s.w * 0.95, s.h * 0.8);
    this.glowMat = glow.mat;
    glow.mesh.position.set(0, s.h * 0.02, 0.03);
    this.state = new Label(Ionization.NAMES[0], { size: s.h * 0.065, color: THEME.ink, bg: 'rgba(255,255,255,0.1)', display: false, weight: 700 });
    this.state.mesh.position.set(0, s.h * 0.39, 0.24);
    const inner = new THREE.Group();
    inner.position.set(0, s.h * 0.02, 0.13);
    inner.add(this.atoms, this.electrons.points);
    this.group.add(glow.mesh, inner, this.state.mesh);
    for (const t of Ionization.NAMES) this.state.setText(t);
    this.state.setText(Ionization.NAMES[0]);
    this.update(0, 0);
  }

  update(dt: number, time: number): void {
    this.t = (this.t + dt) % 11;
    const t = this.t;
    const [bx, by, bz] = this.box;
    let ionized = 0;
    for (let i = 0; i < this.n; i++) {
      // 이온화 시각: 처음엔 드문드문, 갈수록 빨라진다(전자 사태)
      const ionT = 2.6 + 4.2 * Math.pow(rnd(i, 4), 0.55);
      const k = smoothstep(ionT, ionT + 0.35, t);
      ionized += k;
      const x = (rnd(i, 1) - 0.5) * bx + Math.sin(time * (0.3 + rnd(i, 7) * 0.4) + i) * 0.03;
      const y = (rnd(i, 2) - 0.5) * by + Math.cos(time * (0.25 + rnd(i, 8) * 0.4) + i * 2) * 0.03;
      const z = (rnd(i, 3) - 0.5) * bz;
      const pulse = 1 + 0.9 * k * (1 - smoothstep(ionT + 0.2, ionT + 0.7, t));
      this.m.makeScale(pulse, pulse, pulse).setPosition(x, y, z);
      this.atoms.setMatrixAt(i, this.m);
      this.atoms.setColorAt(i, this.c.copy(this.cGas).lerp(this.cIon, k));
      // 전자: 붙어 있을 때는 원자 둘레를 돌고, 떨어지면 멀리 빠르게 날아다닌다
      const a = time * (7 + rnd(i, 5) * 4) + i;
      const orbit = 0.024;
      const free = Math.max(0, t - ionT);
      const dir = rnd(i, 6) * Math.PI * 2;
      const fx = x + Math.cos(dir) * free * 0.42 + Math.cos(a) * orbit;
      const fy = y + Math.sin(dir) * free * 0.3 + Math.sin(a) * orbit;
      this.electrons.pos[i * 3] = ((((fx + bx / 2) % bx) + bx) % bx) - bx / 2;
      this.electrons.pos[i * 3 + 1] = ((((fy + by / 2) % by) + by) % by) - by / 2;
      this.electrons.pos[i * 3 + 2] = z + 0.01;
    }
    this.atoms.instanceMatrix.needsUpdate = true;
    if (this.atoms.instanceColor) this.atoms.instanceColor.needsUpdate = true;
    touch(this.electrons.points);
    this.glowMat.uniforms.uTime.value = time;
    this.glowMat.uniforms.uPower.value = 0.06 + 0.75 * (ionized / this.n);
    const phase = t < 1.8 ? 0 : ionized / this.n < 0.7 ? 1 : 2;
    if (phase !== this.phase) {
      this.phase = phase;
      this.state.setText(Ionization.NAMES[phase]);
    }
  }

  play(): void {
    this.t = 0;
    this.phase = -1;
  }
}

/* ───────────────────────── 화학만 vs 이온 + 화학 ───────────────────────── */

export class TrenchEtch implements Prop {
  readonly group: THREE.Group;
  private readonly bowl: THREE.Mesh;
  private readonly slot: THREE.Mesh;
  private readonly radicals: ReturnType<typeof particles>;
  private readonly ions: ReturnType<typeof particles>;
  private readonly g: { sw: number; sh: number; top: number; ow: number; lx: number; rx: number; z: number };
  private t = 0;

  constructor() {
    const s = slotGroup(PAGE.hero);
    this.group = s.group;
    const sw = s.w * 0.34;
    const sh = s.h * 0.36;
    const top = -s.h * 0.02;
    const ow = sw * 0.2;
    const d = 0.1;
    const z = 0.06;
    const lx = -s.w * 0.23;
    const rx = s.w * 0.23;
    this.g = { sw, sh, top, ow, lx, rx, z: z + d / 2 };
    const hole = new THREE.MeshBasicMaterial({ color: '#04060B' });
    for (const cx of [lx, rx]) {
      const slab = new THREE.Mesh(new RoundedBoxGeometry(sw, sh, d, 2, 0.006), std('#3B4870', { metalness: 0.45, roughness: 0.4, emissive: '#3B4870', emissiveIntensity: 0.15 }));
      slab.position.set(cx, top - sh / 2, z);
      this.group.add(slab);
      const mw = (sw - ow) / 2;
      const mh = s.h * 0.045;
      for (const side of [-1, 1]) {
        const mask = new THREE.Mesh(new THREE.BoxGeometry(mw, mh, d * 1.02), std(THEME.gold, { emissive: THEME.gold, emissiveIntensity: 0.22 }));
        mask.position.set(cx + side * (ow / 2 + mw / 2), top + mh / 2, z);
        this.group.add(mask);
      }
    }
    // 파인 자리: 앞면에 어두운 도형을 키워서 보여 준다
    this.bowl = new THREE.Mesh(new THREE.CircleGeometry(1, 40, Math.PI, Math.PI), hole);
    this.bowl.position.set(lx, top, this.g.z + 0.002);
    const sg = new THREE.PlaneGeometry(ow, 1);
    sg.translate(0, -0.5, 0);
    this.slot = new THREE.Mesh(sg, hole);
    this.slot.position.set(rx, top, this.g.z + 0.002);
    this.group.add(this.bowl, this.slot);
    this.radicals = particles(34, THEME.mint, s.h * 0.045);
    this.ions = particles(30, '#C9A8FF', s.h * 0.05);
    this.group.add(this.radicals.points, this.ions.points);
    const labelMask = tag('감광막', s.h * 0.05, THEME.gold);
    labelMask.mesh.position.set(lx - sw * 0.3, top + s.h * 0.115, this.g.z + 0.01);
    const labelMask2 = tag('감광막', s.h * 0.05, THEME.gold);
    labelMask2.mesh.position.set(rx - sw * 0.3, top + s.h * 0.115, this.g.z + 0.01);
    this.group.add(labelMask.mesh, labelMask2.mesh);
  }

  update(dt: number, time: number): void {
    this.t = (this.t + dt) % 8;
    const g = this.g;
    const k = ease.outQuad(clamp01((this.t - 0.6) / 5.2));
    const depth = Math.max(0.0005, g.sh * 0.8 * k);
    // 화학만: 모든 방향으로 같은 속도 → 반원 모양, 덮개 밑으로도 파고든다
    const rad = Math.max(0.0005, g.ow / 2 + g.sh * 0.42 * k);
    this.bowl.scale.set(rad, Math.max(0.0005, g.sh * 0.44 * k), 1);
    this.slot.scale.y = depth;
    const zf = g.z + 0.012;
    const nr = this.radicals.pos.length / 3;
    for (let i = 0; i < nr; i++) {
      // 라디칼: 제멋대로 떠다닌다 (방향성이 없다)
      const a = time * (0.5 + rnd(i) * 0.9) + rnd(i, 1) * 40;
      const inPit = i % 3 === 0;
      const px = inPit ? Math.cos(a * 1.3) * rad * 0.7 : Math.sin(a) * g.sw * 0.48;
      const py = inPit ? -Math.abs(Math.sin(a * 0.9 + i)) * this.bowl.scale.y * 0.8 : 0.06 + (0.5 + 0.5 * Math.sin(a * 0.7 + i * 3)) * 0.16;
      this.radicals.pos[i * 3] = g.lx + px;
      this.radicals.pos[i * 3 + 1] = g.top + py;
      this.radicals.pos[i * 3 + 2] = zf;
    }
    const ni = this.ions.pos.length / 3;
    for (let i = 0; i < ni; i++) {
      // 이온: 곧게 아래로만 떨어진다. 덮개 위에 떨어진 것은 거기서 멈춘다.
      const kk = (time * (0.7 + rnd(i) * 0.5) + rnd(i, 1)) % 1;
      const x = i % 2 ? (rnd(i, 2) - 0.5) * g.ow * 0.8 : (rnd(i, 2) - 0.5) * g.sw * 0.95;
      const floor = Math.abs(x) < g.ow / 2 ? -depth : 0.03;
      const y0 = 0.26;
      this.ions.pos[i * 3] = g.rx + x;
      this.ions.pos[i * 3 + 1] = g.top + y0 + (floor - y0) * kk * kk;
      this.ions.pos[i * 3 + 2] = zf;
    }
    touch(this.radicals.points);
    touch(this.ions.points);
  }

  play(): void {
    this.t = 0;
  }
}

/* ───────────────────────── CCP 와 ICP ───────────────────────── */

function spiral(r0: number, r1: number, turns: number, y: number): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  const n = Math.round(turns * 28);
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    const a = k * turns * Math.PI * 2;
    const r = r0 + (r1 - r0) * k;
    pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return new THREE.CatmullRomCurve3(pts);
}

export class CcpIcp implements Prop {
  readonly group: THREE.Group;
  private readonly ccp = new THREE.Group();
  private readonly icp = new THREE.Group();
  private readonly eArrows: THREE.Group[] = [];
  private readonly bArrow = new THREE.Group();
  private readonly eC: ReturnType<typeof particles>;
  private readonly eI: ReturnType<typeof particles>;
  private readonly glowC: THREE.ShaderMaterial;
  private readonly glowI: THREE.ShaderMaterial;
  private readonly coilMat: THREE.MeshStandardMaterial;
  private readonly R: number;
  private readonly G: number;

  constructor() {
    const s = slotGroup(PAGE.hero);
    this.group = s.group;
    const R = (this.R = s.w * 0.14);
    const G = (this.G = s.h * 0.3);
    const metal = std('#B9C4DC', { metalness: 0.3, roughness: 0.25 });
    const plate = () => new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.014, 48), metal);
    const arrow = (color: string, len: number, rad: number) => {
      const g = new THREE.Group();
      const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len * 0.72, 8), m);
      shaft.position.y = -len * 0.14;
      const head = new THREE.Mesh(new THREE.ConeGeometry(rad * 3, len * 0.28, 12), m);
      head.position.y = len * 0.36;
      g.add(shaft, head);
      return g;
    };

    // CCP: 평행판 축전기
    const top = plate();
    top.position.y = G / 2;
    const bottom = plate();
    bottom.position.y = -G / 2;
    this.ccp.add(top, bottom);
    for (let i = 0; i < 5; i++) {
      const a = arrow(THEME.cold, G * 0.62, 0.0035);
      const ang = (i / 5) * Math.PI * 2;
      a.position.set(Math.cos(ang) * R * 0.6, 0, Math.sin(ang) * R * 0.6);
      this.eArrows.push(a);
      this.ccp.add(a);
    }
    this.eC = particles(26, '#BFEFFF', s.h * 0.04);
    const gc = plasmaGlow(R * 2.3, G * 1.1);
    this.glowC = gc.mat;
    this.ccp.add(this.eC.points, gc.mesh);
    const lE = tag('전기장 E', s.h * 0.045, THEME.cold);
    lE.mesh.position.set(R * 1.12, G * 0.05, 0);
    this.ccp.add(lE.mesh);

    // ICP: 위에 코일, 아래에 전극
    this.coilMat = std(THEME.copper, { metalness: 0.3, roughness: 0.3, emissive: '#FF8A3D', emissiveIntensity: 0.4 });
    const coil = new THREE.Mesh(new THREE.TubeGeometry(spiral(R * 0.25, R * 0.95, 3, G / 2 + 0.03), 150, 0.008, 8), this.coilMat);
    const win = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.01, 48), new THREE.MeshStandardMaterial({ color: '#CFE8FF', transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false }));
    win.position.y = G / 2;
    const bottom2 = plate();
    bottom2.position.y = -G / 2;
    const torus = new THREE.Mesh(new THREE.TorusGeometry(R * 0.6, R * 0.2, 14, 48), new THREE.MeshBasicMaterial({ color: '#8E6BFF', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    torus.rotation.x = Math.PI / 2;
    torus.position.y = G * 0.12;
    torus.renderOrder = 19;
    this.bArrow.add(arrow(THEME.gold, G * 0.8, 0.0045));
    this.eI = particles(40, '#BFEFFF', s.h * 0.04);
    const gi = plasmaGlow(R * 2.3, G * 1.1);
    this.glowI = gi.mat;
    this.icp.add(coil, win, bottom2, torus, this.bArrow, this.eI.points, gi.mesh);
    const lB = tag('자기장 B', s.h * 0.045, THEME.gold);
    lB.mesh.position.set(-R * 1.15, -G * 0.22, 0);
    const lI = tag('유도 전기장', s.h * 0.045, THEME.cold);
    lI.mesh.position.set(R * 1.22, G * 0.12, 0);
    const lCoil = tag('코일', s.h * 0.045, THEME.copper);
    lCoil.mesh.position.set(-R * 1.2, G / 2 + 0.05, 0);
    this.icp.add(lB.mesh, lI.mesh, lCoil.mesh);

    this.ccp.position.set(-s.w * 0.23, -s.h * 0.02, 0.16);
    this.icp.position.set(s.w * 0.23, -s.h * 0.04, 0.16);
    this.ccp.rotation.x = this.icp.rotation.x = 0.4;
    this.group.add(this.ccp, this.icp);
  }

  update(_dt: number, time: number): void {
    const { R, G } = this;
    const w = Math.sin(time * 4.2); // 교류: 방향이 계속 뒤집힌다 (실제로는 훨씬 빠르다)
    for (const a of this.eArrows) a.scale.set(1, w, 1);
    const nC = this.eC.pos.length / 3;
    for (let i = 0; i < nC; i++) {
      const ang = rnd(i) * Math.PI * 2;
      const rr = Math.sqrt(rnd(i, 1)) * R * 0.85;
      this.eC.pos[i * 3] = Math.cos(ang) * rr;
      this.eC.pos[i * 3 + 1] = (rnd(i, 2) - 0.5) * G * 0.4 - Math.cos(time * 4.2 + rnd(i, 3)) * G * 0.2;
      this.eC.pos[i * 3 + 2] = Math.sin(ang) * rr;
    }
    touch(this.eC.points);
    this.bArrow.scale.set(1, w, 1);
    this.coilMat.emissiveIntensity = 0.35 + 0.5 * Math.abs(w);
    const nI = this.eI.pos.length / 3;
    for (let i = 0; i < nI; i++) {
      // 유도 전기장은 원을 그린다 → 전자가 고리 모양으로 돈다
      const ang = rnd(i) * Math.PI * 2 + time * (2.6 + rnd(i, 1) * 1.2);
      const rr = R * (0.45 + rnd(i, 2) * 0.3);
      this.eI.pos[i * 3] = Math.cos(ang) * rr;
      this.eI.pos[i * 3 + 1] = G * 0.12 + (rnd(i, 3) - 0.5) * G * 0.22;
      this.eI.pos[i * 3 + 2] = Math.sin(ang) * rr;
    }
    touch(this.eI.points);
    this.glowC.uniforms.uTime.value = this.glowI.uniforms.uTime.value = time;
    this.glowC.uniforms.uPower.value = 0.22;
    this.glowI.uniforms.uPower.value = 0.6;
    this.ccp.rotation.y = this.icp.rotation.y = Math.sin(time * 0.4) * 0.25;
  }

  play(): void {}
}

/* ───────────────────────── ICP-RIE 장비 단면 ───────────────────────── */

interface Callout {
  label: Label;
  line: THREE.Line;
  /** 장비 쪽 끝점 (회전하는 모형 좌표) */
  at: THREE.Vector3;
}

export class Reactor implements Prop {
  readonly group = new THREE.Group();
  /** 천천히 좌우로 도는 장비 모형 */
  private readonly model = new THREE.Group();
  private readonly glow: THREE.ShaderMaterial;
  private readonly torusMat: THREE.MeshBasicMaterial;
  private readonly coilMat: THREE.MeshStandardMaterial;
  private readonly subMat: THREE.MeshStandardMaterial;
  private readonly ions: ReturnType<typeof particles>;
  private readonly flow: Array<{ dots: THREE.Mesh[]; path: THREE.Curve<THREE.Vector3>; speed: number }> = [];
  private readonly callouts: Callout[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly power = { v: 1 };
  private readonly dim: { R: number; CH: number; subY: number };
  /** 좌우로 도는 폭(rad). 첫 화면에서는 한 바퀴 돌린다. */
  spin: 'sway' | 'turn' = 'sway';

  constructor(quality: 'high' | 'low', size?: { w: number; h: number }) {
    let w: number;
    let h: number;
    if (size) ({ w, h } = size);
    else {
      const s = slotGroup(PAGE.hero);
      this.group.position.copy(s.group.position);
      ({ w, h } = s);
    }
    const f = fact('sic_continuous_minus50');
    const R = w * 0.185;
    const CH = h * 0.6;
    const cy = h * 0.03;
    const m = this.model;
    m.position.set(0, cy, R + 0.03);
    this.group.add(m);

    // 통: 뒤쪽 절반만 남긴 단면
    const shellMat = new THREE.MeshStandardMaterial({ color: '#8A9CCB', emissive: '#44558F', emissiveIntensity: 0.9, metalness: 0.2, roughness: 0.45, side: THREE.DoubleSide, transparent: true, opacity: 0.34, depthWrite: false });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(R, R, CH, 56, 1, true, Math.PI / 2, Math.PI), shellMat);
    const ringMat = std('#9AA9CC', { metalness: 0.3, roughness: 0.25 });
    for (const y of [CH / 2, -CH / 2]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.035, 10, 64), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      m.add(ring);
    }
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.01, 56), std('#1C2540', { metalness: 0.3, roughness: 0.4 }));
    floor.position.y = -CH / 2;
    const win = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.98, R * 0.98, 0.012, 56), new THREE.MeshStandardMaterial({ color: '#CFE8FF', transparent: true, opacity: 0.2, roughness: 0.08, depthWrite: false }));
    win.position.y = CH / 2;
    win.renderOrder = 15;
    m.add(shell, floor, win);

    // 위쪽 코일 (ICP)
    this.coilMat = std(THEME.copper, { metalness: 0.3, roughness: 0.28, emissive: '#FF8A3D', emissiveIntensity: 0.4 });
    const coilY = CH / 2 + R * 0.12;
    m.add(new THREE.Mesh(new THREE.TubeGeometry(spiral(R * 0.22, R * 0.9, 3.25, coilY), 190, R * 0.04, 10), this.coilMat));

    // 받침대(척)와 시편
    const chuckH = CH * 0.16;
    const chuckY = -CH / 2 + chuckH / 2 + 0.006;
    const chuck = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.66, chuckH, 48), std('#49B9F0', { emissive: THEME.cold, emissiveIntensity: 0.35, metalness: 0.4, roughness: 0.3 }));
    chuck.position.y = chuckY;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.2, R * 0.2, CH * 0.16, 24), std('#39456A', { metalness: 0.3, roughness: 0.4 }));
    stem.position.y = -CH / 2 - CH * 0.08;
    this.subMat = std('#2C3A66', { emissive: THEME.heat, emissiveIntensity: 0, metalness: 0.3, roughness: 0.3 });
    const subY = chuckY + chuckH / 2 + 0.008;
    const sub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.46, R * 0.46, 0.01, 48), this.subMat);
    sub.position.y = subY;
    m.add(chuck, stem, sub);
    this.dim = { R, CH, subY };

    // 플라즈마: 코일 아래 도넛 모양으로 가장 밝다
    this.torusMat = new THREE.MeshBasicMaterial({ color: '#8E6BFF', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    const torus = new THREE.Mesh(new THREE.TorusGeometry(R * 0.5, R * 0.22, 14, 56), this.torusMat);
    torus.rotation.x = Math.PI / 2;
    torus.position.y = CH * 0.2;
    torus.renderOrder = 19;
    const g = plasmaGlow(R * 2.2, CH * 0.95);
    this.glow = g.mat;
    g.mesh.position.y = CH * 0.08;
    m.add(torus, g.mesh);
    if (quality === 'high') {
      const g2 = new THREE.Mesh(g.mesh.geometry, g.mat);
      g2.rotation.y = Math.PI / 2;
      g2.position.y = CH * 0.08;
      g2.renderOrder = 20;
      m.add(g2);
    }
    this.ions = particles(quality === 'high' ? 70 : 34, '#D5BBFF', h * 0.045);
    m.add(this.ions.points);

    // 흐르는 것들: 가스(들어옴), 헬륨(시편 뒷면), 냉매(받침대 ↔ 칠러), 배기
    const tube = (pts: THREE.Vector3[], color: string, rad: number) => {
      const path = new THREE.CatmullRomCurve3(pts);
      m.add(new THREE.Mesh(new THREE.TubeGeometry(path, 40, rad, 8), std(color, { metalness: 0.3, roughness: 0.35, emissive: color, emissiveIntensity: 0.25 })));
      return path;
    };
    const stream = (path: THREE.Curve<THREE.Vector3>, color: string, count: number, speed: number, r: number) => {
      const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      const dots: THREE.Mesh[] = [];
      for (let i = 0; i < count; i++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
        dots.push(d);
        m.add(d);
      }
      this.flow.push({ dots, path, speed });
    };
    const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
    const gasPath = tube([V(-R * 1.55, CH * 0.36), V(-R * 1.1, CH * 0.36), V(-R * 0.86, CH * 0.33)], '#7FE3C4', R * 0.028);
    stream(new THREE.CatmullRomCurve3([...gasPath.points, V(-R * 0.4, CH * 0.26), V(0, CH * 0.2)]), '#A8FFE2', 6, 0.35, R * 0.03);
    stream(new THREE.CatmullRomCurve3([V(R * 0.5, -CH * 0.3), V(R * 0.86, -CH * 0.36), V(R * 1.5, -CH * 0.36)]), '#8C97AE', 4, 0.3, R * 0.026);
    tube([V(R * 0.86, -CH * 0.36), V(R * 1.5, -CH * 0.36)], '#6B7896', R * 0.045);
    const hePath = new THREE.CatmullRomCurve3([V(0, -CH / 2 - CH * 0.16), V(0, chuckY), V(0, subY - 0.006), V(R * 0.4, subY - 0.006, R * 0.1)]);
    stream(hePath, THEME.gold, 6, 0.4, R * 0.028);
    const coolPath = tube([V(-R * 0.6, chuckY), V(-R * 1.0, chuckY - CH * 0.05), V(-R * 1.3, -CH / 2 - CH * 0.1), V(-R * 1.55, -CH / 2 - CH * 0.1)], '#63CBF7', R * 0.03);
    stream(coolPath, '#D8F4FF', 5, 0.35, R * 0.03);
    const chiller = new THREE.Mesh(new RoundedBoxGeometry(R * 0.7, CH * 0.22, R * 0.5, 3, R * 0.05), std('#D9E6F7', { metalness: 0.3, roughness: 0.45, emissive: THEME.cold, emissiveIntensity: 0.12 }));
    chiller.position.set(-R * 1.9, -CH / 2 - CH * 0.1, 0);
    m.add(chiller);

    // 이름표와 지시선
    const ls = h * 0.052;
    const add = (text: string, at: THREE.Vector3, to: THREE.Vector3, fg: string, bg: string) => {
      const label = new Label(text, { size: ls, color: fg, bg, display: false, weight: 700 });
      label.mesh.position.copy(to);
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to.clone()]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0.4 }));
      line.renderOrder = 29;
      this.group.add(line, label.mesh);
      this.callouts.push({ label, line, at });
    };
    const zl = R * 2 + 0.05;
    const dark = '#0B0F1A';
    add(`ICP 코일 ${fmt(f.icp_power_w)} W`, V(R * 0.7, coilY, 0), V(w * 0.33, cy + CH * 0.62, zl), dark, THEME.copper);
    add('플라즈마', V(R * 0.45, CH * 0.2, R * 0.2), V(w * 0.37, cy + CH * 0.22, zl), dark, THEME.plasma);
    add('SiC 시편', V(R * 0.3, subY, R * 0.3), V(w * 0.36, cy - CH * 0.14, zl), THEME.ink, '#2C3A66');
    add(`RIE 전극 ${f.rie_power_w} W`, V(R * 0.55, chuckY, R * 0.3), V(w * 0.34, cy - CH * 0.45, zl), dark, THEME.cold);
    add(`${f.gas} ${f.gas_sccm} sccm`, V(-R * 1.5, CH * 0.36, 0), V(-w * 0.36, cy + CH * 0.6, zl), dark, '#7FE3C4');
    add(`진공 ${f.working_pressure_mTorr} mTorr`, V(R * 1.5, -CH * 0.36, 0), V(w * 0.36, cy - CH * 0.74, zl), THEME.ink, '#3D4A6B');
    add(`He ${f.he_backside_pressure_torr} Torr`, V(0, -CH / 2 - CH * 0.14, 0), V(-w * 0.05, cy - CH * 0.8, zl), dark, THEME.gold);
    add(`칠러 ${fmt(f.chiller_setpoint_c)}°C`, V(-R * 1.9, -CH / 2 - CH * 0.1, 0), V(-w * 0.36, cy - CH * 0.3, zl), dark, '#9BE0FB');
    this.model.rotation.x = 0.3;
    this.update(0, 0);
  }

  update(_dt: number, time: number): void {
    const { R, CH, subY } = this.dim;
    const m = this.model;
    m.rotation.y = this.spin === 'turn' ? time * 0.28 : Math.sin(time * 0.38) * 0.42;
    const p = this.power.v;
    this.glow.uniforms.uTime.value = time;
    this.glow.uniforms.uPower.value = 0.55 * p * (0.94 + Math.sin(time * 9) * 0.05);
    this.torusMat.opacity = 0.3 * Math.min(1.4, p);
    this.coilMat.emissiveIntensity = (0.35 + 0.45 * Math.abs(Math.sin(time * 4.2))) * Math.min(1, p + 0.2);
    this.subMat.emissiveIntensity = 0.3 * Math.min(1, p) + Math.sin(time * 3) * 0.05;
    const n = this.ions.pos.length / 3;
    const top = CH * 0.16;
    for (let i = 0; i < n; i++) {
      const k = (time * (0.5 + rnd(i) * 0.5) + rnd(i, 1) * 7) % 1;
      const a = rnd(i, 2) * Math.PI * 2;
      const r = Math.sqrt(rnd(i, 3)) * R * 0.44;
      this.ions.pos[i * 3] = Math.cos(a) * r;
      // 시편 바로 위(쉬스)에서 급하게 빨라진다
      this.ions.pos[i * 3 + 1] = top + (subY - top) * k * k * k;
      this.ions.pos[i * 3 + 2] = Math.sin(a) * r;
    }
    touch(this.ions.points);
    for (const fl of this.flow)
      fl.dots.forEach((d, i) => {
        const k = (((time * fl.speed + i / fl.dots.length) % 1) + 1) % 1;
        fl.path.getPoint(k, d.position);
        d.scale.setScalar(0.5 + Math.sin(k * Math.PI) * 0.7);
      });
    // 지시선의 장비 쪽 끝을 모형의 회전에 맞춘다
    m.updateMatrix();
    for (const c of this.callouts) {
      this.tmp.copy(c.at).applyMatrix4(m.matrix);
      const pos = c.line.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, this.tmp.x, this.tmp.y, this.tmp.z);
      pos.needsUpdate = true;
    }
  }

  play(motion: Motion): void {
    motion.kill(this.power);
    this.power.v = 0.05;
    motion.to(this.power, { v: 1.6 }, 0.6, { delay: 0.3, ease: ease.outExpo });
    motion.to(this.power, { v: 1 }, 1.4, { delay: 0.95, ease: ease.inOutSine });
    this.callouts.forEach((c, i) => popLabel(motion, c.label, 0.5 + i * 0.12));
  }
}

/* ───────────────────────── 열이 빠져나가는 길 ───────────────────────── */

export class HeatPath implements Prop {
  readonly group: THREE.Group;
  private readonly tilt = new THREE.Group();
  private readonly heat: ReturnType<typeof particles>;
  private readonly he: ReturnType<typeof particles>;
  private readonly glow: THREE.ShaderMaterial;
  private readonly ys: number[];
  private readonly lw: number;
  private readonly labels: Label[] = [];

  constructor() {
    const s = slotGroup(PAGE.hero);
    this.group = s.group;
    const f = fact('sic_continuous_minus50');
    const lw = (this.lw = s.w * 0.34);
    const d = 0.18;
    const cx = -s.w * 0.2;
    this.tilt.position.set(cx, 0, 0.14);
    this.tilt.rotation.x = 0.36;
    this.group.add(this.tilt);
    const u = s.h;
    // 위에서부터: 시편 / 홀더 / (틈) / 받침대 / 냉매
    const layers: Array<{ name: string; hh: number; ww: number; color: string; glow: number; gapAfter: number }> = [
      { name: `시편 ${f.sample_final_c}°C`, hh: u * 0.055, ww: lw * 0.5, color: '#B4532F', glow: 0.75, gapAfter: u * 0.03 },
      { name: `홀더 ${f.holder_final_c}°C`, hh: u * 0.06, ww: lw * 0.82, color: '#C7862A', glow: 0.7, gapAfter: u * 0.1 },
      { name: '받침대', hh: u * 0.11, ww: lw, color: '#5B6C96', glow: 0.12, gapAfter: u * 0.025 },
      { name: `냉매 ${fmt(f.chiller_setpoint_c)}°C`, hh: u * 0.06, ww: lw, color: '#2FA6E0', glow: 0.6, gapAfter: 0 },
    ];
    let y = u * 0.24;
    this.ys = [u * 0.42];
    const lx = lw / 2 + s.w * 0.115;
    const mk = (text: string, yy: number, color: string) => {
      const l = tag(text, u * 0.046, color);
      l.mesh.position.set(cx + lx, yy, 0.2);
      this.group.add(l.mesh);
      this.labels.push(l);
    };
    layers.forEach((L, i) => {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(L.ww, L.hh, d, 3, L.hh * 0.14), std(L.color, { emissive: L.color, emissiveIntensity: L.glow, metalness: 0.4, roughness: 0.35 }));
      mesh.position.y = y - L.hh / 2;
      this.tilt.add(mesh);
      mk(L.name, y - L.hh / 2, i < 2 ? THEME.heat : i === 3 ? THEME.cold : THEME.dim);
      this.ys.push(y, y - L.hh);
      if (i === 1) mk(`틈 · He ${f.he_backside_pressure_torr} Torr`, y - L.hh - L.gapAfter / 2, THEME.gold);
      y -= L.hh + L.gapAfter;
    });
    mk('플라즈마', u * 0.37, THEME.plasma);
    const g = plasmaGlow(lw * 1.3, u * 0.3);
    this.glow = g.mat;
    g.mesh.position.set(0, u * 0.36, 0);
    this.tilt.add(g.mesh);
    this.heat = particles(70, '#FFFFFF', u * 0.04, true);
    this.he = particles(16, THEME.gold, u * 0.03);
    this.tilt.add(this.heat.points, this.he.points);
  }

  update(_dt: number, time: number): void {
    this.tilt.rotation.y = Math.sin(time * 0.4) * 0.3;
    this.glow.uniforms.uTime.value = time;
    this.glow.uniforms.uPower.value = 0.6;
    // ys: [위, 시편 위/아래, 홀더 위/아래, 받침대 위/아래, 냉매 위/아래]
    const ys = this.ys;
    const gapTop = ys[4];
    const gapBot = ys[5];
    const n = this.heat.pos.length / 3;
    const hot = [1, 0.55, 0.25];
    const cold = [0.35, 0.8, 1];
    for (let i = 0; i < n; i++) {
      const k = (time * (0.13 + rnd(i) * 0.05) + rnd(i, 1)) % 1;
      // 틈에서 오래 머문다(열 저항): 전체 시간의 절반을 틈을 건너는 데 쓴다
      let yy: number;
      if (k < 0.25) yy = ys[0] + (gapTop - ys[0]) * (k / 0.25);
      else if (k < 0.75) yy = gapTop + (gapBot - gapTop) * ((k - 0.25) / 0.5);
      else yy = gapBot + (ys[8] - gapBot) * ((k - 0.75) / 0.25);
      const spread = k < 0.25 ? 0.5 + k * 1.2 : 0.85;
      this.heat.pos[i * 3] = (rnd(i, 2) - 0.5) * this.lw * spread;
      this.heat.pos[i * 3 + 1] = yy;
      this.heat.pos[i * 3 + 2] = (rnd(i, 3) - 0.5) * 0.14;
      const c = smoothstep(0.7, 1, k);
      for (let j = 0; j < 3; j++) this.heat.col![i * 3 + j] = hot[j] + (cold[j] - hot[j]) * c;
    }
    touch(this.heat.points);
    touch(this.heat.points, 'color');
    const nh = this.he.pos.length / 3;
    for (let i = 0; i < nh; i++) {
      this.he.pos[i * 3] = ((((rnd(i) + time * 0.06) % 1) + 1) % 1 - 0.5) * this.lw * 0.8;
      this.he.pos[i * 3 + 1] = gapBot + (gapTop - gapBot) * (0.5 + 0.4 * Math.sin(time * 3 + i * 1.7));
      this.he.pos[i * 3 + 2] = (rnd(i, 1) - 0.5) * 0.14;
    }
    touch(this.he.points);
  }

  play(motion: Motion): void {
    this.labels.forEach((l, i) => popLabel(motion, l, 0.3 + i * 0.12));
  }
}

/* ───────────────────────── 조립 ───────────────────────── */

export function buildProps(quality: 'high' | 'low'): Record<string, Prop> {
  const er = fact('sic_etch_rate_setpoints');
  const mt = fact('sic_mounting_comparison');
  const cu = fact('cu_profile_postprocessing');
  const [cw] = rectSize(CHART);
  const ls = 0.036;

  const etchColors = [THEME.cold, THEME.plasma, THEME.gold];
  const etch = new BarChart(
    CHART,
    er.conditions.map((c: any, i: number) => ({ u: barU(CHART, i, 3), value: c.etch_rate_nm_per_min, color: etchColors[i], label: `${c.etch_rate_nm_per_min}` })),
    240,
    (cw / 3) * 0.42,
    0.05,
  );
  const mountColors = [THEME.cold, THEME.plasma, THEME.gold, THEME.heat];
  const mount = new BarChart(
    CHART,
    mt.conditions.map((c: any, i: number) => ({ u: barU(CHART, i, 4), value: c.sample_c, color: mountColors[i], label: `${c.sample_c}°C` })),
    110,
    (cw / 4) * 0.46,
    0.042,
  );
  const pairW = (cw / 3) * 0.26;
  const cuSpecs: BarSpec[] = [];
  cu.comparisons.forEach((c: any, i: number) => {
    const u = barU(CHART, i, 3);
    cuSpecs.push({ u: u - pairW * 0.6, value: c.after_pr_strip_angstrom, color: '#7C879E', label: fmt(c.after_pr_strip_angstrom), labelColor: THEME.dim });
    cuSpecs.push({ u: u + pairW * 0.6, value: c.after_di_hcl_angstrom, color: THEME.mint, label: fmt(c.after_di_hcl_angstrom), labelColor: THEME.mint });
  });
  const cuChart = new BarChart(CHART, cuSpecs, 16000, pairW, ls * 0.8);

  return {
    intro: new WaferHero(),
    why_etch: new LithoStack(),
    plasma_state: new Ionization(),
    how_etch: new TrenchEtch(),
    ccp_icp: new CcpIcp(),
    plasma_basics: new Reactor(quality),
    heat_path: new HeatPath(),
    continuous_heat: new ThermoPair(),
    cyclic_cooling: new CyclicChart(),
    etch_rates: etch,
    supports: mount,
    cu_profiles: cuChart,
    mo_reference: new MoStack(),
  };
}

/* ───────────────────────── 떠다니는 빛 알갱이 ───────────────────────── */

const DRIFT_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uSize;
uniform float uHeight;
varying float vAlpha;
void main() {
  vec3 p = position;
  float t = uTime * (0.012 + aSeed * 0.02);
  p.y = mod(p.y + t + uHeight * 0.5, uHeight) - uHeight * 0.5;
  p.x += sin(uTime * 0.4 + aSeed * 40.0) * 0.012;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.5 + aSeed) * projectionMatrix[1][1] / -mv.z;
  vAlpha = 0.3 + 0.4 * sin(uTime * (0.8 + aSeed) + aSeed * 30.0);
}`;
const DRIFT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a * vAlpha * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}`;

export class Drift {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;

  constructor(count: number) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const height = H * 1.1;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 1.2;
      pos[i * 3 + 1] = (Math.random() - 0.5) * height;
      pos[i * 3 + 2] = 0.02 + Math.random() * Z.particlesMax;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSize: { value: 1 }, uHeight: { value: height }, uColor: { value: new THREE.Color('#BBD6FF') }, uOpacity: { value: 0 } },
      vertexShader: DRIFT_VERT,
      fragmentShader: DRIFT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 40;
  }

  /** viewportHeight: 렌더 타깃 세로 픽셀. 포인트 크기를 포스터 단위로 맞추는 데 쓴다. */
  update(time: number, viewportHeight: number, worldScale: number): void {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uSize.value = 0.012 * worldScale * viewportHeight * 0.5;
  }

  get opacity(): { value: number } {
    return this.mat.uniforms.uOpacity as { value: number };
  }
}
