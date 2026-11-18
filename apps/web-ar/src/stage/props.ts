/**
 * 포스터 앞에 떠 있는 3D 소품: 실험 장치 모형과 그래프.
 * (3D 는 장비·기판·그래프에만 쓴다. 토끼는 rabbit/ 의 2D 리그다.)
 * 값은 전부 poster_facts.json 에서 온다.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { posterFacts } from '@rabbit/content';
import { H, SLOTS, type UvRect, Z, barU, rectCenter, rectSize, uvToLocal } from '../ar/sceneLayout';
import { type Motion, ease } from '../motion/tween';
import { Label } from './labels';
import { THEME, fmt } from './posterArt';

const fact = (id: string): any => posterFacts.facts.find((f) => f.id === id);

export interface Prop {
  readonly group: THREE.Group;
  /** 강조될 때 다시 재생하는 연출 */
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

/* ───────────────────────── 막대 그래프 ───────────────────────── */

export interface BarSpec {
  /** 포스터 u 좌표(막대 중심) */
  u: number;
  value: number;
  color: string;
  label: string;
  /** 폭 배율 */
  width?: number;
  labelColor?: string;
}

export class BarChart implements Prop {
  readonly group: THREE.Group;
  private readonly bars: Array<{ mesh: THREE.Mesh; label: Label; height: number; baseY: number }> = [];

  constructor(slot: UvRect, specs: BarSpec[], max: number, barWidth: number, labelSize = 0.024) {
    const s = slotGroup(slot);
    this.group = s.group;
    const usable = s.h * 0.74;
    const depth = Math.min(0.034, barWidth * 0.8);
    for (const spec of specs) {
      const w = barWidth * (spec.width ?? 1);
      const geo = new RoundedBoxGeometry(w, 1, depth, 3, Math.min(w, depth) * 0.16);
      geo.translate(0, 0.5, depth / 2);
      const mesh = new THREE.Mesh(geo, std(spec.color));
      const height = Math.max(0.006, (spec.value / max) * usable);
      const baseY = -s.h / 2 + 0.004;
      mesh.position.set(spec.u - 0.5 - s.cx, baseY, 0.002);
      mesh.scale.y = height;
      this.group.add(mesh);
      const label = new Label(spec.label, { size: labelSize, color: spec.labelColor ?? THEME.navy, halo: '#FFFFFF' });
      label.mesh.position.set(mesh.position.x, baseY + height + labelSize * 0.82, depth + 0.004);
      this.group.add(label.mesh);
      this.bars.push({ mesh, label, height, baseY });
    }
  }

  play(motion: Motion): void {
    this.bars.forEach((b, i) => {
      motion.kill(b.mesh.scale);
      b.mesh.scale.y = 0.0005;
      motion.to(b.mesh.scale, { y: b.height }, 0.85, { delay: 0.12 + i * 0.13, ease: ease.outBack });
      popLabel(motion, b.label, 0.6 + i * 0.13);
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
  private readonly cold = new THREE.Color('#39C2F2');
  private readonly hot: THREE.Color;
  level = 0;

  constructor(h: number, name: string, hot: string, private readonly range: [number, number]) {
    this.hot = new THREE.Color(hot);
    const r = h * 0.075;
    this.tubeH = h * 0.66;
    const bulbY = -h / 2 + r * 1.9;
    const glass = new THREE.MeshStandardMaterial({ color: '#FFFFFF', transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0 });
    const tube = new THREE.Mesh(new THREE.CapsuleGeometry(r, this.tubeH, 6, 16), glass);
    tube.position.y = bulbY + this.tubeH / 2 + r * 0.6;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(r * 1.75, 20, 14), glass);
    bulb.position.y = bulbY;
    this.fillMat = std('#39C2F2', { emissive: '#000000', roughness: 0.3 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(r * 1.32, 18, 12), this.fillMat);
    core.position.y = bulbY;
    const fillGeo = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 1, 14);
    fillGeo.translate(0, 0.5, 0);
    this.fill = new THREE.Mesh(fillGeo, this.fillMat);
    this.fill.position.y = bulbY + r * 0.8;
    this.group.add(core, this.fill, tube, bulb);
    tube.renderOrder = 12;
    bulb.renderOrder = 12;

    const nameLabel = new Label(name, { size: h * 0.105, color: THEME.navy, halo: '#FFFFFF' });
    nameLabel.mesh.position.set(0, h / 2 - h * 0.02, r);
    this.value = new Label('', { size: h * 0.12, color: '#FFFFFF', bg: hot });
    this.value.mesh.position.set(r * 4.6, 0, r * 1.5);
    this.group.add(nameLabel.mesh, this.value.mesh);
    this.setLevel(0);
  }

  /** k: 0 = 시작 온도, 1 = 끝 온도 (표시 범위 0~110°C 기준 높이) */
  setLevel(k: number): void {
    this.level = k;
    const t = this.range[0] + (this.range[1] - this.range[0]) * k;
    const frac = Math.max(0.03, Math.min(1, t / 110));
    this.fill.scale.y = this.tubeH * frac;
    this.fillMat.color.copy(this.cold).lerp(this.hot, k);
    this.fillMat.emissive.copy(this.hot).multiplyScalar(0.35 * k);
    this.value.mesh.position.y = this.fill.position.y + this.fill.scale.y;
  }
}

export class ThermoPair implements Prop {
  readonly group: THREE.Group;
  private readonly a: Thermometer;
  private readonly b: Thermometer;
  private readonly timer: Label;
  private readonly f = fact('sic_continuous_minus50');
  private progress = { k: 1 };

  constructor() {
    const s = slotGroup(SLOTS.thermometers);
    this.group = s.group;
    const f = this.f;
    this.a = new Thermometer(s.h * 0.8, 'SiC 시편', THEME.heat, [f.sample_initial_c, f.sample_final_c]);
    this.b = new Thermometer(s.h * 0.8, '홀더', '#F59E0B', [f.holder_initial_c, f.holder_final_c]);
    this.a.group.position.set(-s.w * 0.3, -s.h * 0.06, 0.03);
    this.b.group.position.set(s.w * 0.14, -s.h * 0.06, 0.03);
    this.timer = new Label(`플라즈마 ON ${f.plasma_on_duration_s}초`, { size: s.h * 0.085, color: '#FFFFFF', bg: THEME.plasma });
    this.timer.mesh.position.set(-s.w * 0.06, s.h * 0.5, 0.05);
    this.group.add(this.a.group, this.b.group, this.timer.mesh);
    this.apply(1);
  }

  /** 끝점 두 개만 측정값이므로, 숫자 표시는 시작값과 끝값만 보여 준다(중간값을 지어내지 않는다). */
  private apply(k: number): void {
    const f = this.f;
    this.a.setLevel(k);
    this.b.setLevel(k);
    const end = k >= 0.999;
    this.a.value.setText(end ? `${f.sample_final_c}°C` : `${f.sample_initial_c}°C →`);
    this.b.value.setText(end ? `${f.holder_final_c}°C` : `${f.holder_initial_c}°C →`);
  }

  play(motion: Motion): void {
    motion.kill(this.progress);
    this.progress.k = 0;
    this.apply(0);
    popLabel(motion, this.timer, 0.1);
    motion.to(this.progress, { k: 1 }, 2.6, {
      delay: 0.5,
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
  private readonly points: Array<{ dot: THREE.Mesh; label: Label; tag: Label }> = [];
  private readonly segs: Array<{ mesh: THREE.Mesh; len: number }> = [];

  constructor() {
    const s = slotGroup(SLOTS.cyclicChart);
    this.group = s.group;
    const seq = fact('sic_cyclic_minus50').sequence as Array<{ stage: string; sample_c: number }>;
    const names = ['시작', '깎기 1', '쉬기 1', '깎기 2', '쉬기 2', '깎기 3'];
    const max = 40;
    const x0 = -s.w * 0.42;
    const dx = (s.w * 0.84) / (seq.length - 1);
    const y0 = -s.h * 0.3;
    const usable = s.h * 0.62;
    const pos = seq.map((p, i) => {
      const hot = i % 2 === 1;
      // 뜨거운 점은 관람객 쪽으로 더 튀어나온다 → 시점을 옮기면 지그재그가 입체로 보인다.
      return new THREE.Vector3(x0 + dx * i, y0 + (p.sample_c / max) * usable, hot ? 0.07 : 0.03);
    });
    const r = s.h * 0.042;
    const hotMat = std(THEME.heat, { emissive: THEME.heat, emissiveIntensity: 0.25 });
    const coldMat = std(THEME.cold, { emissive: THEME.cold, emissiveIntensity: 0.2 });

    for (let i = 0; i < pos.length - 1; i++) {
      const a = pos[i];
      const b = pos[i + 1];
      const len = a.distanceTo(b);
      const geo = new THREE.CylinderGeometry(r * 0.36, r * 0.36, 1, 10);
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
      const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), i === 0 ? coldMat : hot ? hotMat : coldMat);
      dot.position.copy(p);
      const label = new Label(`${seq[i].sample_c}`, { size: s.h * 0.115, color: hot ? '#C2401F' : '#0A6E99', halo: '#FFFFFF' });
      label.mesh.position.set(p.x, p.y + (hot ? r * 2.9 : -r * 2.9), p.z + 0.004);
      const tag = new Label(names[i], { size: s.h * 0.07, color: THEME.sub, display: false, weight: 700 });
      tag.mesh.position.set(p.x, -s.h / 2 + s.h * 0.065, 0.004);
      this.group.add(dot, label.mesh, tag.mesh);
      this.points.push({ dot, label, tag });
    });
    const unit = new Label('°C', { size: s.h * 0.07, color: THEME.sub, display: false, weight: 700 });
    unit.mesh.position.set(-s.w / 2 + s.h * 0.1, s.h / 2 - s.h * 0.07, 0.004);
    this.group.add(unit.mesh);
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

  constructor() {
    const s = slotGroup(SLOTS.moStack);
    this.group = s.group;
    const w = s.w * 0.78;
    const d = 0.07;
    const layers: Array<[string, string, number]> = [
      ['Mo', '#7C83A8', s.h * 0.2],
      ['Cu', '#E08A4A', s.h * 0.3],
      ['Mo', '#7C83A8', s.h * 0.2],
    ];
    let y = -s.h * 0.4;
    for (const [name, color, hh] of layers) {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, hh, d, 3, hh * 0.14), std(color, { metalness: 0.35, roughness: 0.3 }));
      const cy = y + hh / 2;
      mesh.position.set(0, cy, d / 2 + 0.004);
      const label = new Label(name, { size: hh * 0.62, color: '#FFFFFF' });
      label.mesh.position.set(0, 0, d / 2 + 0.003);
      mesh.add(label.mesh);
      this.group.add(mesh);
      this.slabs.push({ mesh, y: cy });
      y += hh + s.h * 0.035;
    }
  }

  play(motion: Motion): void {
    this.slabs.forEach((sl, i) => {
      motion.kill(sl.mesh.position);
      sl.mesh.position.y = sl.y + 0.16;
      sl.mesh.visible = false;
      motion.after(0.1 + i * 0.22, () => (sl.mesh.visible = true), sl.mesh.position);
      motion.to(sl.mesh.position, { y: sl.y }, 0.6, { delay: 0.1 + i * 0.22, ease: ease.outBounce });
    });
  }
}

/* ───────────────────────── 실험 장치 모형 ───────────────────────── */

const PLASMA_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const PLASMA_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
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
  float body = smoothstep(0.52, 0.0, length(p * vec2(1.0, 1.55)));
  float a = body * (0.5 + 0.7 * n) * uPower;
  vec3 col = mix(vec3(0.48, 0.30, 1.0), vec3(1.0, 0.52, 0.86), n);
  col = mix(col, vec3(1.0), body * body * 0.45);
  gl_FragColor = vec4(col * a, a);
}`;

export class Chamber implements Prop {
  readonly group: THREE.Group;
  private readonly plasmaMat: THREE.ShaderMaterial;
  private readonly ions: THREE.Points;
  private readonly ionPos: Float32Array;
  private readonly ionSeed: Float32Array;
  private readonly heDots: THREE.Mesh[] = [];
  private readonly hePath: THREE.CatmullRomCurve3;
  private readonly substrateMat: THREE.MeshStandardMaterial;
  private readonly plasmaTop: number;
  private readonly plasmaBottom: number;
  private readonly width: number;
  private power = { v: 1 };

  constructor(quality: 'high' | 'low') {
    const s = slotGroup(SLOTS.chamber);
    this.group = s.group;
    const w = s.w;
    const h = s.h;
    const zc = 0.075; // 장치 중심이 포스터에서 약 4.5 cm 앞
    const chuckW = w * 0.52;
    const chuckH = h * 0.2;
    const chuckY = -h * 0.36;

    // 차가운 받침대
    const chuck = new THREE.Mesh(new RoundedBoxGeometry(chuckW, chuckH, 0.09, 4, chuckH * 0.22), std('#3FB6EC', { emissive: '#1EB4EA', emissiveIntensity: 0.25, roughness: 0.25 }));
    chuck.position.set(0, chuckY, zc);
    // 기판
    this.substrateMat = std('#26365F', { emissive: '#FF6B4A', emissiveIntensity: 0, roughness: 0.35, metalness: 0.3 });
    const subH = h * 0.055;
    const sub = new THREE.Mesh(new RoundedBoxGeometry(chuckW * 0.78, subH, 0.075, 2, subH * 0.3), this.substrateMat);
    sub.position.set(0, chuckY + chuckH / 2 + subH / 2 + h * 0.012, zc);
    // 가스가 들어오는 윗판
    const head = new THREE.Mesh(new RoundedBoxGeometry(chuckW * 0.92, h * 0.09, 0.085, 3, h * 0.03), std('#C9D4E6', { metalness: 0.5, roughness: 0.3 }));
    head.position.set(0, h * 0.42, zc);
    // 칠러 상자와 배관
    const chillerW = w * 0.17;
    const chiller = new THREE.Mesh(new RoundedBoxGeometry(chillerW, h * 0.5, 0.07, 4, chillerW * 0.14), std('#EAF2FB', { roughness: 0.5 }));
    chiller.position.set(w * 0.4, -h * 0.2, zc * 0.8);
    const pipeMat = std('#63C7F2', { emissive: '#1EB4EA', emissiveIntensity: 0.3 });
    const pipe = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(w * 0.4 - chillerW / 2, -h * 0.3, zc), new THREE.Vector3(w * 0.3, -h * 0.36, zc), new THREE.Vector3(chuckW / 2, chuckY, zc)]), 16, h * 0.018, 8), pipeMat);
    this.group.add(chuck, sub, head, chiller, pipe);

    // 플라즈마 빛: 깊이를 달리한 얇은 판 석 장 (옆에서 보면 부피처럼 보인다)
    this.plasmaTop = h * 0.36;
    this.plasmaBottom = sub.position.y + subH / 2;
    this.width = chuckW * 0.8;
    this.plasmaMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPower: { value: 1 } },
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const ph = this.plasmaTop - this.plasmaBottom;
    for (const dz of quality === 'high' ? [-0.025, 0, 0.025] : [0]) {
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(chuckW * 1.15, ph * 1.5), this.plasmaMat);
      glow.position.set(0, (this.plasmaTop + this.plasmaBottom) / 2, zc + dz);
      glow.renderOrder = 20;
      this.group.add(glow);
    }

    // 기판으로 떨어지는 알갱이(이온)
    const count = quality === 'high' ? 46 : 22;
    this.ionPos = new Float32Array(count * 3);
    this.ionSeed = new Float32Array(count);
    for (let i = 0; i < count; i++) this.ionSeed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.ionPos, 3));
    const dot = document.createElement('canvas');
    dot.width = dot.height = 48;
    const dc = dot.getContext('2d')!;
    const g = dc.createRadialGradient(24, 24, 1, 24, 24, 23);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,190,240,0.9)');
    g.addColorStop(1, 'rgba(160,110,255,0)');
    dc.fillStyle = g;
    dc.fillRect(0, 0, 48, 48);
    this.ions = new THREE.Points(geo, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(dot), size: h * 0.075, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.ions.position.z = zc;
    this.ions.renderOrder = 22;
    this.ions.frustumCulled = false;
    this.group.add(this.ions);

    // 뒷면 헬륨: 받침대와 기판 사이를 흐르는 점
    this.hePath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-w * 0.46, -h * 0.44, zc + 0.03),
      new THREE.Vector3(-chuckW * 0.56, chuckY - chuckH * 0.2, zc + 0.05),
      new THREE.Vector3(-chuckW * 0.4, chuckY + chuckH / 2 + h * 0.006, zc + 0.05),
      new THREE.Vector3(chuckW * 0.4, chuckY + chuckH / 2 + h * 0.006, zc + 0.05),
    ]);
    const heMat = new THREE.MeshBasicMaterial({ color: '#FFE08A', toneMapped: false });
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(h * 0.02, 10, 8), heMat);
      this.heDots.push(m);
      this.group.add(m);
    }

    // 이름표
    const f = fact('sic_continuous_minus50');
    const tags: Array<[string, number, number, string, string]> = [
      ['플라즈마', -w * 0.39, h * 0.12, '#FFFFFF', '#7C4DFF'],
      [`${f.gas} 가스`, -w * 0.36, h * 0.42, '#12264A', '#DCE6F5'],
      ['SiC 기판', w * 0.37, sub.position.y + h * 0.11, '#FFFFFF', '#26365F'],
      ['He', -w * 0.44, -h * 0.3, '#5A3D00', '#FFE08A'],
      [`칠러 ${fmt(f.chiller_setpoint_c)}°C`, w * 0.4, h * 0.14, '#06394F', '#9BE0FB'],
    ];
    for (const [t, x, y, fg, bg] of tags) {
      const l = new Label(t, { size: h * 0.082, color: fg, bg, display: false, weight: 700 });
      l.mesh.position.set(x, y, zc + 0.06);
      this.group.add(l.mesh);
    }
  }

  update(dt: number, time: number): void {
    this.plasmaMat.uniforms.uTime.value = time;
    this.plasmaMat.uniforms.uPower.value = this.power.v * (0.92 + Math.sin(time * 9) * 0.05);
    const n = this.ionSeed.length;
    const span = this.plasmaTop - this.plasmaBottom;
    for (let i = 0; i < n; i++) {
      const s = this.ionSeed[i];
      const k = (time * (0.55 + s * 0.5) + s * 7.3) % 1;
      this.ionPos[i * 3] = (((s * 97.3) % 1) - 0.5) * this.width + Math.sin(time * 2 + s * 20) * 0.003;
      this.ionPos[i * 3 + 1] = this.plasmaTop - k * k * span;
      this.ionPos[i * 3 + 2] = (((s * 31.7) % 1) - 0.5) * 0.05;
    }
    (this.ions.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.heDots.forEach((m, i) => {
      const k = (((time * 0.32 + i / this.heDots.length) % 1) + 1) % 1;
      this.hePath.getPoint(k, m.position);
      m.scale.setScalar(0.6 + Math.sin(k * Math.PI) * 0.6);
    });
    // 플라즈마를 받는 동안 기판이 은은하게 달아오른다(열이 전달된다는 뜻의 연출).
    this.substrateMat.emissiveIntensity = 0.22 * this.power.v + Math.sin(time * 3) * 0.05;
    void dt;
  }

  play(motion: Motion): void {
    motion.kill(this.power);
    this.power.v = 0.05;
    motion.to(this.power, { v: 1.5 }, 0.5, { delay: 0.25, ease: ease.outExpo });
    motion.to(this.power, { v: 1 }, 1.4, { delay: 0.8, ease: ease.inOutSine });
  }
}

/* ───────────────────────── 조립 ───────────────────────── */

export function buildCharts(quality: 'high' | 'low') {
  const er = fact('sic_etch_rate_setpoints');
  const mt = fact('sic_mounting_comparison');
  const cu = fact('cu_profile_postprocessing');
  const [etchW] = rectSize(SLOTS.etchBars);
  const [mountW] = rectSize(SLOTS.mountBars);
  const [cuW] = rectSize(SLOTS.cuBars);

  const etchColors = [THEME.cold, '#2BB6A8', THEME.gold];
  const etch = new BarChart(
    SLOTS.etchBars,
    er.conditions.map((c: any, i: number) => ({ u: barU(SLOTS.etchBars, i, 3), value: c.etch_rate_nm_per_min, color: etchColors[i], label: `${c.etch_rate_nm_per_min}` })),
    240,
    (etchW / 3) * 0.5,
    0.03,
  );
  const mountColors = [THEME.cold, THEME.plasma, '#F59E0B', '#F97316'];
  const mount = new BarChart(
    SLOTS.mountBars,
    mt.conditions.map((c: any, i: number) => ({ u: barU(SLOTS.mountBars, i, 4), value: c.sample_c, color: mountColors[i], label: `${c.sample_c}°C` })),
    130,
    (mountW / 4) * 0.42,
    0.026,
  );
  const pairW = (cuW / 3) * 0.24;
  const cuSpecs: BarSpec[] = [];
  cu.comparisons.forEach((c: any, i: number) => {
    const u = barU(SLOTS.cuBars, i, 3);
    cuSpecs.push({ u: u - pairW * 0.62, value: c.after_pr_strip_angstrom, color: '#B6C2D3', label: fmt(c.after_pr_strip_angstrom), labelColor: THEME.sub });
    cuSpecs.push({ u: u + pairW * 0.62, value: c.after_di_hcl_angstrom, color: THEME.mint, label: fmt(c.after_di_hcl_angstrom), labelColor: '#0B7F5C' });
  });
  const cuChart = new BarChart(SLOTS.cuBars, cuSpecs, 16000, pairW, 0.0185);

  return {
    chamber: new Chamber(quality),
    thermo: new ThermoPair(),
    cyclic: new CyclicChart(),
    etch,
    mount,
    cu: cuChart,
    mo: new MoStack(),
  };
}

/* ───────────────────────── 떠다니는 얼음 입자 ───────────────────────── */

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
  vAlpha = 0.35 + 0.45 * sin(uTime * (0.8 + aSeed) + aSeed * 30.0);
}`;
const DRIFT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  float cross = max(smoothstep(0.06, 0.0, abs(c.x)) , smoothstep(0.06, 0.0, abs(c.y))) * smoothstep(0.5, 0.1, d);
  a = max(a * a, cross * 0.8) * vAlpha * uOpacity;
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
      uniforms: { uTime: { value: 0 }, uSize: { value: 1 }, uHeight: { value: height }, uColor: { value: new THREE.Color('#8FE0FF') }, uOpacity: { value: 0 } },
      vertexShader: DRIFT_VERT,
      fragmentShader: DRIFT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 40;
  }

  /** viewportHeight: 렌더 타깃 세로 픽셀. 포인트 크기를 포스터 단위로 맞추는 데 쓴다. */
  update(time: number, viewportHeight: number, worldScale: number): void {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uSize.value = 0.016 * worldScale * viewportHeight * 0.5;
  }

  get opacity(): { value: number } {
    return this.mat.uniforms.uOpacity as { value: number };
  }
}

export { uvToLocal };
