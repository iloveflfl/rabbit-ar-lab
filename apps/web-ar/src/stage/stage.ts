/**
 * LabStage — 포스터 좌표계 안의 모든 것(덮어쓰는 슬라이드, 3D 시뮬, 2D 안내 토끼)과 장면 연출.
 * AR 에서는 추적 앵커 아래에, 2D 보기에서는 고정 카메라 앞에 같은 스테이지를 그대로 쓴다.
 *
 * 장면 하나 = 슬라이드 한 장. 포스터 전체를 한 장의 발표 화면으로 쓰고, 장면이 바뀌면
 * 빛줄기가 위에서 아래로 훑으며 다음 장으로 넘어간다.
 *
 * 해설이 끝나면 "진짜 포스터 읽기": 타일이 뒤집히며 원본 포스터가 드러나고(AR 에서는 실물 종이 그대로),
 * 스캔 선이 내려가며 같은 자리의 글이 한국어로 바뀐 뒤, 구역을 하나씩 밝혀 가며 읽는다.
 */
import * as THREE from 'three';
import type { HighlightId, RabbitClip, SceneAction } from '@rabbit/shared';
import { isHighlightId, isSceneAction } from '@rabbit/shared';
import { sceneScripts, scenes } from '@rabbit/content';
import { GUIDE, H, POSTER_IMG, READ_VIEW, type UvRect, Z, uvToLocal } from '../ar/sceneLayout';
import { Motion, ease } from '../motion/tween';
import { RabbitSprite } from '../rabbit/rabbitSprite';
import { Label } from './labels';
import { loadPosterFonts, pageAccent, paintPage } from './posterArt';
import { Drift, type Prop, buildProps } from './props';

export type Quality = 'high' | 'low';

export interface SceneEvent {
  id: string;
  index: number;
  total: number;
  title: string;
  chip: string;
  /** 0 시작 · 1 기초 · 2 장비 · 3 결과 */
  part: number;
  accent: string;
  lines: string[];
  highlight: HighlightId | null;
  /** 채팅 답변이 불러낸 장면이면 true (자막을 바꾸지 않는다) */
  silent: boolean;
}

const POSTER_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const POSTER_FRAG = /* glsl */ `
uniform sampler2D mapA;
uniform sampler2D mapB;
uniform float uAlphaA;
uniform float uAlphaB;
uniform float uMix;
uniform float uFx; // 0 빛줄기 넘김 · 1 타일 뒤집기 · 2 번역 스캔
uniform float uReveal;
uniform float uOpacity;
uniform float uAspect; // 세로/가로
uniform float uTime;
uniform vec3 uAccent;
uniform vec4 uFocus; // u0, v0, u1, v1 (v 는 위→아래)
uniform float uFocusAmt;
uniform float uFrame;
varying vec2 vUv;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uvA = vUv;
  vec2 uvB = vUv;
  float showB = 0.0;
  float glowAmt = 0.0;
  float hole = 0.0;
  float moving = step(0.001, uMix) * step(uMix, 0.999);

  if (uFx < 0.5) {
    // 장 넘김: 비스듬한 빛줄기가 위에서 아래로 훑고 지나간 자리에 다음 장이 나타난다.
    float s = (1.0 - vUv.y) + vUv.x * 0.22;
    float edge = uMix * 1.5 - 0.14;
    showB = 1.0 - smoothstep(edge - 0.09, edge, s);
    float beam = smoothstep(edge - 0.11, edge - 0.004, s) * (1.0 - smoothstep(edge - 0.004, edge + 0.012, s));
    glowAmt = beam * 0.9 * moving;
  } else if (uFx < 1.5) {
    // 타일 뒤집기: 가운데에서 바깥으로 물결치며 타일이 한 장씩 돌아 뒷면(다음 그림)이 나온다.
    vec2 g = vec2(10.0, floor(10.0 * uAspect + 0.5));
    vec2 id = floor(vUv * g);
    vec2 f = fract(vUv * g);
    vec2 c = (id + 0.5) / g - 0.5;
    float t0 = length(c * vec2(1.0, uAspect)) * 0.62 + hash(id) * 0.2;
    float p = clamp((uMix * 1.16 - t0) / 0.32, 0.0, 1.0);
    float w = abs(cos(p * 3.14159265));
    float fx = (f.x - 0.5) / max(w, 0.002) + 0.5;
    hole = step(0.5, abs(fx - 0.5));
    showB = step(0.5, p);
    vec2 uvT = (id + vec2(clamp(fx, 0.0, 1.0), f.y)) / g;
    uvA = uvT;
    uvB = uvT;
    float turn = sin(p * 3.14159265);
    float rim = smoothstep(0.42, 0.5, abs(fx - 0.5)) + smoothstep(0.44, 0.5, abs(f.y - 0.5));
    glowAmt = turn * (0.3 + rim * 0.9) * (1.0 - hole);
  } else {
    // 번역 스캔: 밝은 선이 위에서 아래로 내려가고, 선이 지나는 띠에서는 글 조각들이 깜빡이며 바뀐다.
    float s = 1.0 - vUv.y;
    float edge = uMix * 1.3 - 0.13;
    float k = clamp((edge - s) / 0.15, 0.0, 1.0);
    vec2 cell = floor(vUv * vec2(40.0, 40.0 * uAspect * 2.4));
    float n = hash(cell + floor(uTime * 16.0) * 7.3);
    showB = step(n, k * 1.2);
    float inBand = k * (1.0 - k) * 4.0;
    float row = floor(vUv.y * 110.0);
    float sh = (hash(vec2(row, floor(uTime * 22.0))) - 0.5) * 0.03 * inBand;
    uvA.x += sh;
    uvB.x += sh * 0.4;
    float line = exp(-abs(s - edge) * 130.0);
    float halo = exp(-abs(s - edge) * 16.0) * 0.22;
    float grid = step(0.9, fract(vUv.x * 40.0)) * inBand * 0.25;
    glowAmt = (line * 1.4 + halo + grid) * moving;
  }

  vec3 col = mix(texture2D(mapA, uvA).rgb, texture2D(mapB, uvB).rgb, showB);
  float al = mix(uAlphaA, uAlphaB, showB) * (1.0 - hole);
  col += uAccent * glowAmt;
  al = max(al, min(1.0, glowAmt));

  vec2 q = (vUv - 0.5) * vec2(1.0, uAspect);

  // 구역 짚기: 고른 구역만 밝게 남기고 나머지는 가라앉힌다.
  vec2 fc = vec2((uFocus.x + uFocus.z) * 0.5, 1.0 - (uFocus.y + uFocus.w) * 0.5);
  vec2 fh = vec2(uFocus.z - uFocus.x, (uFocus.w - uFocus.y) * uAspect) * 0.5;
  float fd = sdRoundBox((vUv - fc) * vec2(1.0, uAspect), fh, 0.014);
  float outside = smoothstep(-0.003, 0.003, fd) * uFocusAmt;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, mix(vec3(lum), vec3(0.02, 0.03, 0.07), 0.74), outside);
  float fl = 1.0 - smoothstep(0.0, 0.0045, abs(fd));
  col = mix(col, uAccent, fl * uFocusAmt);

  // 등장: 가운데에서 퍼지는 원형 와이프 + 빛나는 테두리
  float r = length(q);
  float wob = sin(atan(q.y, q.x) * 6.0 + uTime * 2.0) * 0.012;
  float e2 = uReveal * 1.02 + wob * (1.0 - uReveal);
  float shown = 1.0 - smoothstep(e2 - 0.02, e2, r);
  float ring = smoothstep(e2 - 0.11, e2 - 0.01, r) * (1.0 - smoothstep(e2 - 0.01, e2 + 0.012, r));
  ring *= (1.0 - smoothstep(0.92, 1.0, uReveal));
  col = mix(col, uAccent, ring * 0.85);

  // 둥근 모서리 + (실물 포스터를 그대로 보여 줄 때) 가장자리를 도는 빛 테두리
  float d = sdRoundBox(q, vec2(0.5, 0.5 * uAspect), 0.028);
  float corner = 1.0 - smoothstep(-0.003, 0.0, d);
  float fr = (1.0 - smoothstep(0.0, 0.005, abs(d + 0.007))) * uFrame;
  float sweep = 0.55 + 0.45 * sin(atan(q.y, q.x) * 2.0 - uTime * 1.6);
  col = mix(col, uAccent, fr);
  al = max(al, fr * sweep);
  float a = max(shown * al, ring) * uOpacity * corner;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

/** scenes_ko.json 의 rabbit_clip 이름 → 실제 클립 */
function clipFor(name: string): RabbitClip {
  switch (name) {
    case 'rabbit_wave':
    case 'rabbit_point':
    case 'rabbit_surprised':
    case 'rabbit_cooling':
    case 'rabbit_cheer':
    case 'rabbit_think':
    case 'rabbit_talk':
    case 'rabbit_idle':
      return name;
    default:
      return 'rabbit_talk'; // 'rabbit_explain' 등
  }
}

const ACTION_SCENE: Partial<Record<SceneAction, string>> = {
  show_heating: 'continuous_heat',
  show_cooling: 'cyclic_cooling',
  show_etch_rate: 'etch_rates',
  show_mounting: 'supports',
  show_cu_profile: 'cu_profiles',
  show_mo: 'mo_reference',
};
const HIGHLIGHT_SCENE: Record<HighlightId, string> = {
  motivation: 'why_etch',
  methods: 'plasma_basics',
  results_thermal_continuous: 'continuous_heat',
  results_thermal_cyclic: 'cyclic_cooling',
  results_etch_rate: 'etch_rates',
  results_mounting: 'supports',
  results_cu_profile: 'cu_profiles',
  results_mo: 'mo_reference',
  conclusions: 'conclusion',
};

export class LabStage {
  /** 포스터 좌표계 루트. 이 그룹을 앵커/카메라 앞에 붙인다. */
  readonly root = new THREE.Group();
  readonly motion = new Motion();
  readonly rabbit: RabbitSprite;
  private readonly content = new THREE.Group(); // 원본 보기에서 숨기는 것들
  private readonly posterMat: THREE.ShaderMaterial;
  private readonly posterMesh: THREE.Mesh;
  /** 슬라이드 두 장: 지금 보이는 장(front)과 다음에 넘길 장(back) */
  private readonly canvases = [document.createElement('canvas'), document.createElement('canvas')];
  private textures: THREE.CanvasTexture[] = [];
  /** 원본 포스터와 한국어 번역판 (받는 대로 채워진다) */
  private readonly images: Partial<Record<keyof typeof POSTER_IMG, THREE.Texture>> = {};
  /** 지금 포스터 면에 보이는 것 */
  private shown: 'slide' | keyof typeof POSTER_IMG | null = null;
  private turning = false;
  /** 실물 포스터가 뒤에 있는가 (AR). 그러면 '원본'은 그림을 덮지 않고 종이를 그대로 보여 준다. */
  hasPaper = false;
  private readonly outline: THREE.LineLoop;
  private readonly props: Record<string, Prop>;
  private activeProp: Prop | null = null;
  private readonly drift: Drift;
  private readonly rabbitPos = { x: 0, y: 0, hop: 0, scale: 1 };
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private revealed = false;
  private mode: 'rabbit' | 'original' = 'rabbit';
  sceneIndex = -1;
  onScene: ((e: SceneEvent) => void) | null = null;

  constructor(readonly quality: Quality) {
    // 조명은 포스터에 묶는다: 어느 각도에서 봐도 소품의 명암이 포스터 기준으로 일정하다.
    const hemi = new THREE.HemisphereLight('#FFFFFF', '#5A6C99', 1.35);
    const key = new THREE.DirectionalLight('#FFFFFF', 2.2);
    key.position.set(-0.5, 0.9, 1.4);
    const rim = new THREE.DirectionalLight('#8FB8FF', 1.1);
    rim.position.set(0.9, -0.2, 0.8);
    this.root.add(hemi, key, key.target, rim, rim.target);

    this.posterMat = new THREE.ShaderMaterial({
      uniforms: {
        mapA: { value: null },
        mapB: { value: null },
        uAlphaA: { value: 1 },
        uAlphaB: { value: 1 },
        uMix: { value: 0 },
        uFx: { value: 0 },
        uFocus: { value: new THREE.Vector4(0, 0, 1, 1) },
        uFocusAmt: { value: 0 },
        uFrame: { value: 0 },
        uReveal: { value: 0 },
        uOpacity: { value: 1 },
        uAspect: { value: H },
        uTime: { value: 0 },
        uAccent: { value: new THREE.Color('#5CC8FF') },
      },
      vertexShader: POSTER_VERT,
      fragmentShader: POSTER_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.posterMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, H), this.posterMat);
    this.posterMesh.position.z = Z.overlay;
    this.posterMesh.renderOrder = 1;
    this.root.add(this.posterMesh);

    // 원본 보기: 덮개를 걷고 포스터 윤곽만 남긴다.
    const og = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -H / 2, 0), new THREE.Vector3(0.5, -H / 2, 0), new THREE.Vector3(0.5, H / 2, 0), new THREE.Vector3(-0.5, H / 2, 0)]);
    this.outline = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0.9 }));
    this.outline.position.z = Z.overlay;
    this.outline.visible = false;
    this.root.add(this.outline);

    this.props = buildProps(quality);
    for (const p of Object.values(this.props)) {
      p.group.visible = false;
      this.content.add(p.group);
    }

    this.drift = new Drift(quality === 'high' ? 70 : 28);
    this.content.add(this.drift.points);

    this.rabbit = new RabbitSprite(quality);
    this.rabbit.group.visible = false;
    this.rabbit.shadow.visible = false;
    this.rabbit.shadow.position.z = Z.decal;
    this.content.add(this.rabbit.shadow, this.rabbit.group);
    this.rabbit.animator.onClipEnd = (ended) => this.afterClip(ended);
    const [gx, gy] = uvToLocal(GUIDE.u, GUIDE.v);
    Object.assign(this.rabbitPos, { x: gx, y: gy, scale: GUIDE.scale });

    this.root.add(this.content);
  }

  async init(renderer: THREE.WebGLRenderer): Promise<void> {
    await loadPosterFonts();
    Label.refreshAll();
    paintPage(this.canvases[0], 0);
    paintPage(this.canvases[1], 0);
    this.textures = this.canvases.map((c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      return t;
    });
    this.posterMat.uniforms.mapA.value = this.textures[0];
    this.posterMat.uniforms.mapB.value = this.textures[1];

    // 원본·번역 포스터는 뒤에서 받아 둔다 (마지막 장들에서만 쓴다).
    const loader = new THREE.TextureLoader();
    for (const key of Object.keys(POSTER_IMG) as Array<keyof typeof POSTER_IMG>) {
      loader.load(POSTER_IMG[key], (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        renderer.initTexture(t);
        this.images[key] = t;
        // 받기 전에 이미 그 장에 와 있었다면 지금 보여 준다.
        const cur = scenes[this.sceneIndex]?.id;
        if (cur && READ_VIEW[cur]?.tex === key) this.showView(cur, this.sceneIndex, false);
      });
    }
  }

  /* ───────── 매 프레임 ───────── */

  update(dt: number, camera: THREE.Camera, viewportHeight: number): void {
    this.motion.update(dt);
    const t = this.motion.time;
    this.posterMat.uniforms.uTime.value = t;
    if (!this.motion.paused) this.activeProp?.update?.(dt, t);

    this.root.matrixWorld.decompose(this.tmpV, this.tmpQ, this.tmpS);
    this.drift.update(t, viewportHeight, this.tmpS.x);

    // 안내 토끼: 위치 + 폴짝 뛰는 호
    const r = this.rabbit;
    const rp = this.rabbitPos;
    r.group.position.set(rp.x, rp.y + rp.hop, Z.rabbit);
    r.group.scale.setScalar(rp.scale);
    r.shadow.position.x = rp.x;
    r.shadow.position.y = rp.y - 0.004;
    const lift = 1 - Math.min(1, rp.hop * 6);
    r.shadow.scale.setScalar(rp.scale * (0.7 + 0.3 * lift));
    if (r.group.visible) r.update(this.motion.paused ? 0 : dt, camera);
  }

  /* ───────── 등장 ───────── */

  get isRevealed(): boolean {
    return this.revealed;
  }

  /** 포스터를 처음 찾았을 때 한 번만 재생하는 등장 연출. */
  reveal(): void {
    if (this.revealed) return;
    this.revealed = true;
    const m = this.motion;
    const u = this.posterMat.uniforms;
    u.uReveal.value = 0;
    m.to(u.uReveal, { value: 1 }, 1.25, { ease: ease.inOutCubic });
    m.to(this.drift.opacity, { value: 1 }, 1.6, { delay: 0.8 });

    // 안내 토끼가 아래에서 폴짝 뛰어올라 인사한다.
    const [x, y] = uvToLocal(GUIDE.u, GUIDE.v);
    const rp = this.rabbitPos;
    rp.x = x;
    rp.y = y - 0.3;
    m.after(1.0, () => {
      this.rabbit.group.visible = true;
      this.rabbit.shadow.visible = true;
      this.rabbit.animator.play('rabbit_cheer', GUIDE.side);
    });
    m.to(rp, { y }, 0.8, { delay: 1.0, ease: ease.outBack });
    m.run(0.8, (k) => (rp.hop = Math.sin(k * Math.PI) * 0.1), { delay: 1.0 });
    // 등장 중에 관람객이 이미 다른 장면을 골랐다면 덮어쓰지 않는다.
    m.after(0.9, () => {
      if (this.sceneIndex < 0) this.goScene('intro');
    });
  }

  /** 등장 연출 없이 바로 완성 상태로 (추적을 다시 잡았을 때 등). */
  showInstant(): void {
    if (this.revealed) return;
    this.revealed = true;
    this.posterMat.uniforms.uReveal.value = 1;
    this.drift.opacity.value = 1;
    this.rabbit.group.visible = true;
    this.rabbit.shadow.visible = true;
    this.goScene('intro');
  }

  /* ───────── 장면 ───────── */

  /** 포스터 면을 다른 그림으로 바꾼다. fx: 0 빛줄기 · 1 타일 뒤집기 · 2 번역 스캔 */
  private turn(tex: THREE.Texture, alpha: number, fx: 0 | 1 | 2): void {
    const u = this.posterMat.uniforms;
    if (this.turning) this.finishTurn();
    u.mapB.value = tex;
    u.uAlphaB.value = alpha;
    u.uFx.value = fx;
    u.uMix.value = 0.001;
    this.turning = true;
    const [dur, e] = fx === 0 ? [0.85, ease.inOutCubic] : fx === 1 ? [1.5, ease.inOutSine] : [2.4, ease.inOutSine];
    this.motion.to(u.uMix, { value: 1 }, dur, { ease: e, onComplete: () => this.finishTurn() });
  }

  private finishTurn(): void {
    if (!this.turning) return;
    this.turning = false;
    const u = this.posterMat.uniforms;
    this.motion.kill(u.uMix);
    u.mapA.value = u.mapB.value;
    u.uAlphaA.value = u.uAlphaB.value;
    u.uMix.value = 0;
  }

  /** 밝게 남길 구역을 옮긴다 (null 이면 전체를 밝게). */
  private setFocus(rect: UvRect | null, delay = 0): void {
    const u = this.posterMat.uniforms;
    const m = this.motion;
    const v = u.uFocus.value as THREE.Vector4;
    m.kill(u.uFocusAmt);
    m.kill(v);
    if (!rect) {
      m.to(u.uFocusAmt, { value: 0 }, 0.4);
      return;
    }
    const to = { x: rect.u0, y: rect.v0, z: rect.u1, w: rect.v1 };
    if (u.uFocusAmt.value < 0.02) v.set(to.x, to.y, to.z, to.w);
    else m.to(v, to, 0.8, { ease: ease.inOutCubic });
    m.to(u.uFocusAmt, { value: 1 }, 0.6, { delay });
  }

  /** 장면에 맞는 그림을 포스터 면에 올린다: 해설 슬라이드, 원본 포스터, 한국어 번역판. */
  private showView(id: string, index: number, same: boolean): void {
    const u = this.posterMat.uniforms;
    const view = READ_VIEW[id];
    (u.uAccent.value as THREE.Color).set(view?.accent ?? pageAccent(id));
    if (!this.textures.length) return;
    const m = this.motion;
    m.kill(u.uFrame);

    if (!view) {
      this.setFocus(null);
      m.to(u.uFrame, { value: 0 }, 0.3);
      if (same && this.shown === 'slide') return;
      if (this.turning) this.finishTurn();
      if (this.shown === null) {
        // 첫 장: 넘김 없이 바로
        paintPage(this.canvases[0], index);
        this.textures[0].needsUpdate = true;
        u.mapA.value = this.textures[0];
        u.uAlphaA.value = 1;
      } else {
        const i = u.mapA.value === this.textures[0] ? 1 : 0;
        paintPage(this.canvases[i], index);
        this.textures[i].needsUpdate = true;
        this.turn(this.textures[i], 1, this.shown === 'slide' ? 0 : 1);
      }
      this.shown = 'slide';
      return;
    }

    const tex = this.images[view.tex];
    if (!tex) return; // 아직 받는 중: 받으면 init 의 콜백이 다시 부른다.
    const alpha = view.tex === 'original' && this.hasPaper ? 0 : 1;
    let turned = false;
    if (this.shown !== view.tex) {
      // 원본 → 번역은 스캔, 그 밖에는 타일 뒤집기
      this.turn(tex, alpha, view.tex === 'ko' && this.shown === 'original' ? 2 : 1);
      this.shown = view.tex;
      turned = true;
    }
    this.setFocus(view.focus, turned ? 1.3 : 0);
    m.to(u.uFrame, { value: alpha === 0 ? 1 : 0 }, 0.6, { delay: turned && alpha === 0 ? 1.0 : 0 });
  }

  goScene(id: string, opts: { silent?: boolean } = {}): void {
    const index = scenes.findIndex((s) => s.id === id);
    if (index < 0) return;
    if (!this.revealed) {
      this.revealed = true;
      this.posterMat.uniforms.uReveal.value = 1;
      this.drift.opacity.value = 1;
      this.rabbit.group.visible = true;
      this.rabbit.shadow.visible = true;
    }
    const scene = scenes[index];
    const script = sceneScripts[index];
    const accent = READ_VIEW[id]?.accent ?? pageAccent(id);
    const same = index === this.sceneIndex;
    this.sceneIndex = index;
    this.showView(id, index, same);

    // 3D 시뮬: 이전 것은 줄여서 치우고, 새 것은 장이 넘어간 뒤에 키운다.
    const m = this.motion;
    const next = this.props[id] ?? null;
    const prev = this.activeProp;
    if (prev && prev !== next) {
      m.kill(prev.group.scale);
      m.to(prev.group.scale, { x: 0.001, y: 0.001, z: 0.001 }, 0.25, { ease: ease.inCubic, onComplete: () => (prev.group.visible = false) });
    }
    this.activeProp = next;
    if (next) {
      m.kill(next.group.scale);
      m.kill(next);
      next.group.visible = true;
      if (!same) next.group.scale.setScalar(0.001);
      m.to(next.group.scale, { x: 1, y: 1, z: 1 }, 0.7, { delay: same ? 0 : 0.4, ease: ease.outBack });
      m.after(same ? 0 : 0.45, () => next.play(m), next);
    }

    // 안내 토끼: 장이 바뀔 때 폴짝
    const rp = this.rabbitPos;
    if (!same) m.run(0.5, (k) => (rp.hop = Math.sin(k * Math.PI) * 0.05), { delay: 0.2 });
    const clip = clipFor(scene.rabbit_clip);
    m.kill(this.rabbit);
    m.after(0.35, () => this.rabbit.animator.play(clip, GUIDE.side), this.rabbit);

    this.onScene?.({
      id,
      index,
      total: scenes.length,
      title: scene.title_ko.replace(/^🐰\s*/, ''),
      chip: script.chip,
      part: script.part,
      accent,
      lines: script.lines,
      highlight: script.highlight,
      silent: opts.silent ?? false,
    });
  }

  next(): void {
    this.goScene(scenes[Math.min(scenes.length - 1, this.sceneIndex + 1)].id);
  }
  prev(): void {
    this.goScene(scenes[Math.max(0, this.sceneIndex - 1)].id);
  }

  /** 단발 클립이 끝나면: 그림을 설명 중이면 가리키는 자세, 아니면 idle. */
  private afterClip(ended: RabbitClip): void {
    if (this.sceneIndex < 0) return;
    const id = scenes[this.sceneIndex].id;
    if (id !== 'intro' && id !== 'conclusion' && id !== 'original' && id !== 'read_conclusion' && ended !== 'rabbit_wave') this.rabbit.animator.play('rabbit_point', GUIDE.side);
  }

  /**
   * 채팅 답변이 고른 동작을 실행한다. allowlist 밖의 값은 무시한다.
   * (서버·릴레이에서도 걸렀지만 화면 쪽에서 한 번 더 확인한다.)
   */
  runAction(action: unknown, highlight: unknown): void {
    if (!this.revealed) return;
    const hl = isHighlightId(highlight) ? highlight : null;
    const current = scenes[this.sceneIndex]?.id;
    // 지금 보는 장이 그 주제에 속하면(예: 기초 지식 장) 굳이 다른 장으로 넘기지 않는다.
    const onTopic = hl !== null && sceneScripts[this.sceneIndex]?.highlight === hl;
    if (!isSceneAction(action)) {
      if (hl && !onTopic) this.goScene(HIGHLIGHT_SCENE[hl], { silent: true });
      return;
    }
    const sceneId = ACTION_SCENE[action] ?? (hl && !onTopic ? HIGHLIGHT_SCENE[hl] : null);
    if (sceneId && sceneId !== current) this.goScene(sceneId, { silent: true });
    else if (sceneId) this.activeProp?.play(this.motion);
    if (action === 'rabbit_greet') this.rabbit.animator.play('rabbit_wave', GUIDE.side);
    else if (action === 'rabbit_surprised') this.rabbit.animator.play('rabbit_surprised', GUIDE.side);
    else if (action === 'show_heating') this.motion.after(0.5, () => this.rabbit.animator.play('rabbit_surprised', GUIDE.side));
  }

  setTalking(on: boolean): void {
    const a = this.rabbit.animator;
    a.talking = on;
    if (on && a.clip === 'rabbit_idle') a.play('rabbit_talk');
    if (!on && a.clip === 'rabbit_talk') a.play('rabbit_idle');
  }

  setThinking(on: boolean): void {
    const a = this.rabbit.animator;
    if (on) a.play('rabbit_think');
    else if (a.clip === 'rabbit_think') a.play('rabbit_idle');
  }

  /* ───────── 보기 전환 / 추적 상태 ───────── */

  setMode(mode: 'rabbit' | 'original'): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const m = this.motion;
    const u = this.posterMat.uniforms.uOpacity;
    m.kill(u);
    if (mode === 'original') {
      m.to(u, { value: 0 }, 0.35, { onComplete: () => (this.posterMesh.visible = false) });
      this.content.visible = false;
      this.outline.visible = true;
    } else {
      this.posterMesh.visible = true;
      this.content.visible = true;
      this.outline.visible = false;
      m.to(u, { value: 1 }, 0.35);
    }
  }

  get viewMode(): 'rabbit' | 'original' {
    return this.mode;
  }

  /** 추적을 놓치면 연출을 멈추고, 다시 잡으면 이어서 재생한다. */
  setTracking(on: boolean): void {
    this.motion.paused = !on;
    if (on && this.revealed) {
      const u = this.posterMat.uniforms.uOpacity;
      if (this.mode === 'rabbit') {
        u.value = 0.3;
        this.motion.to(u, { value: 1 }, 0.3);
      }
    }
  }

  /* ───────── 터치 ───────── */

  /** 화면 좌표(NDC)로 슬라이드를 눌렀는지 본다. 눌렀으면 지금 장의 시뮬을 처음부터 다시 재생한다. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): HighlightId | null {
    if (!this.revealed || this.mode !== 'rabbit') return null;
    this.raycaster.setFromCamera(ndc, camera);
    return this.hit();
  }

  /** 세계 좌표의 광선으로 고른다 (WebXR 의 화면 탭). */
  pickRay(origin: THREE.Vector3, direction: THREE.Vector3): HighlightId | null {
    if (!this.revealed || this.mode !== 'rabbit') return null;
    this.raycaster.set(origin, direction);
    return this.hit();
  }

  private hit(): HighlightId | null {
    if (this.raycaster.intersectObject(this.posterMesh, false)[0]) this.replay();
    return null;
  }

  /** 지금 장의 시뮬을 처음부터 다시 재생한다. */
  replay(): void {
    // 번역 장에서는 원본 → 한국어로 바뀌는 스캔을 다시 보여 준다.
    const id = scenes[this.sceneIndex]?.id;
    const { original, ko } = this.images;
    if (id === 'read_overview' && original && ko && !this.turning && this.shown === 'ko') {
      const u = this.posterMat.uniforms;
      u.mapA.value = original;
      u.uAlphaA.value = this.hasPaper ? 0 : 1;
      this.turn(ko, 1, 2);
      return;
    }
    if (this.activeProp) {
      this.motion.kill(this.activeProp);
      this.activeProp.play(this.motion);
    }
  }

  /** 채팅 답변 등이 주제를 가리켰을 때 그 주제의 장으로. */
  selectPanel(id: HighlightId): void {
    this.goScene(HIGHLIGHT_SCENE[id]);
  }

  dispose(): void {
    this.motion.killAll();
    this.rabbit.dispose();
    for (const t of this.textures) t.dispose();
    for (const t of Object.values(this.images)) t.dispose();
    this.posterMat.dispose();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    Label.reset();
  }
}
