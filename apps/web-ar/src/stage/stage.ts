/**
 * LabStage — 포스터 좌표계 안의 모든 것(덮어쓰는 슬라이드, 3D 시뮬, 2D 안내 토끼)과 장면 연출.
 * AR 에서는 추적 앵커 아래에, 2D 보기에서는 고정 카메라 앞에 같은 스테이지를 그대로 쓴다.
 *
 * 장면 하나 = 슬라이드 한 장. 포스터 전체를 한 장의 발표 화면으로 쓰고, 장면이 바뀌면
 * 빛줄기가 위에서 아래로 훑으며 다음 장으로 넘어간다.
 */
import * as THREE from 'three';
import type { HighlightId, RabbitClip, SceneAction } from '@rabbit/shared';
import { isHighlightId, isSceneAction } from '@rabbit/shared';
import { sceneScripts, scenes } from '@rabbit/content';
import { GUIDE, H, Z, uvToLocal } from '../ar/sceneLayout';
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
uniform float uMix;
uniform float uReveal;
uniform float uOpacity;
uniform float uAspect; // 세로/가로
uniform float uTime;
uniform vec3 uAccent;
varying vec2 vUv;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  // 장 넘김: 비스듬한 빛줄기가 위에서 아래로 훑고 지나간 자리에 다음 장이 나타난다.
  float s = (1.0 - vUv.y) + vUv.x * 0.22;
  float edge = uMix * 1.5 - 0.14;
  float showB = 1.0 - smoothstep(edge - 0.09, edge, s);
  vec3 col = mix(texture2D(mapA, vUv).rgb, texture2D(mapB, vUv).rgb, showB);
  float moving = step(0.001, uMix) * step(uMix, 0.999);
  float beam = smoothstep(edge - 0.11, edge - 0.004, s) * (1.0 - smoothstep(edge - 0.004, edge + 0.012, s));
  col += uAccent * beam * 0.9 * moving;

  // 등장: 가운데에서 퍼지는 원형 와이프 + 빛나는 테두리
  vec2 q = (vUv - 0.5) * vec2(1.0, uAspect);
  float r = length(q);
  float wob = sin(atan(q.y, q.x) * 6.0 + uTime * 2.0) * 0.012;
  float e2 = uReveal * 1.02 + wob * (1.0 - uReveal);
  float shown = 1.0 - smoothstep(e2 - 0.02, e2, r);
  float ring = smoothstep(e2 - 0.11, e2 - 0.01, r) * (1.0 - smoothstep(e2 - 0.01, e2 + 0.012, r));
  ring *= (1.0 - smoothstep(0.92, 1.0, uReveal));
  col = mix(col, uAccent, ring * 0.85);

  // 둥근 모서리
  float d = sdRoundBox(q, vec2(0.5, 0.5 * uAspect), 0.028);
  float corner = 1.0 - smoothstep(-0.003, 0.0, d);
  float a = max(shown, ring) * uOpacity * corner;
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
  private front = 0;
  private turning = false;
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
        uMix: { value: 0 },
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

  /** 다음 장을 뒤쪽 캔버스에 그리고 넘긴다. */
  private turnTo(index: number, accent: string): void {
    const u = this.posterMat.uniforms;
    const m = this.motion;
    if (!this.textures.length) return;
    if (this.turning) this.finishTurn();
    (u.uAccent.value as THREE.Color).set(accent);
    if (this.sceneIndex < 0) {
      // 첫 장: 넘김 없이 바로
      paintPage(this.canvases[this.front], index);
      this.textures[this.front].needsUpdate = true;
      return;
    }
    const back = 1 - this.front;
    paintPage(this.canvases[back], index);
    this.textures[back].needsUpdate = true;
    this.turning = true;
    u.uMix.value = 0.001;
    m.to(u.uMix, { value: 1 }, 0.85, { ease: ease.inOutCubic, onComplete: () => this.finishTurn() });
  }

  private finishTurn(): void {
    if (!this.turning) return;
    this.turning = false;
    const u = this.posterMat.uniforms;
    this.motion.kill(u.uMix);
    this.front = 1 - this.front;
    u.mapA.value = this.textures[this.front];
    u.mapB.value = this.textures[1 - this.front];
    u.uMix.value = 0;
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
    const accent = pageAccent(id);
    const same = index === this.sceneIndex;
    if (!same) this.turnTo(index, accent);
    this.sceneIndex = index;

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
    if (id !== 'intro' && id !== 'conclusion' && ended !== 'rabbit_wave') this.rabbit.animator.play('rabbit_point', GUIDE.side);
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
    this.posterMat.dispose();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    Label.reset();
  }
}
