/**
 * LabStage — 포스터 좌표계 안의 모든 것(덮어쓰는 2D 포스터, 3D 소품, 2D 토끼)과 장면 연출.
 * AR 에서는 추적 앵커 아래에, 2D 보기에서는 고정 카메라 앞에 같은 스테이지를 그대로 쓴다.
 */
import * as THREE from 'three';
import type { HighlightId, RabbitClip, SceneAction } from '@rabbit/shared';
import { isHighlightId, isSceneAction } from '@rabbit/shared';
import { sceneScripts, scenes } from '@rabbit/content';
import { H, PANELS, STATIONS, type UvRect, Z, localToUv, rectCenter, rectSize, uvToLocal } from '../ar/sceneLayout';
import { Motion, ease } from '../motion/tween';
import { RabbitSprite } from '../rabbit/rabbitSprite';
import { loadPosterFonts, paintPoster } from './posterArt';
import { Drift, type Prop, buildCharts } from './props';

export type Quality = 'high' | 'low';
export type SceneId = (typeof scenes)[number]['id'];

export interface SceneEvent {
  id: string;
  index: number;
  total: number;
  title: string;
  chip: string;
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
uniform sampler2D map;
uniform float uReveal;
uniform float uOpacity;
uniform float uFocusAmt;
uniform vec4 uFocus;   // u0, v0, u1, v1 (v 는 위가 0)
uniform float uAspect; // 세로/가로
uniform float uTime;
varying vec2 vUv;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec4 tex = texture2D(map, vUv);
  vec3 col = tex.rgb;

  // 강조: 선택한 패널 밖을 살짝 가라앉힌다.
  vec2 uvTop = vec2(vUv.x, 1.0 - vUv.y);
  vec2 c = (uFocus.xy + uFocus.zw) * 0.5;
  vec2 hb = (uFocus.zw - uFocus.xy) * 0.5;
  vec2 p = (uvTop - c) * vec2(1.0, uAspect);
  float d = sdRoundBox(p, hb * vec2(1.0, uAspect) + 0.012, 0.03);
  float outside = smoothstep(0.0, 0.03, d);
  vec3 dim = mix(col, vec3(0.06, 0.11, 0.24), 0.52);
  col = mix(col, dim, outside * uFocusAmt);

  // 등장: 가운데에서 퍼지는 원형 와이프 + 빛나는 테두리
  vec2 q = (vUv - 0.5) * vec2(1.0, uAspect);
  float r = length(q);
  float wob = sin(atan(q.y, q.x) * 6.0 + uTime * 2.0) * 0.012;
  float edge = uReveal * 1.02 + wob * (1.0 - uReveal);
  float shown = 1.0 - smoothstep(edge - 0.02, edge, r);
  float ring = smoothstep(edge - 0.11, edge - 0.01, r) * (1.0 - smoothstep(edge - 0.01, edge + 0.012, r));
  ring *= (1.0 - smoothstep(0.92, 1.0, uReveal));
  col = mix(col, vec3(0.75, 0.95, 1.0), ring * 0.85);
  float a = max(shown, ring) * uOpacity;

  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

const FRAME_FRAG = /* glsl */ `
uniform vec2 uSize;
uniform vec3 uColor;
uniform float uTime;
uniform float uAmt;
varying vec2 vUv;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  float pad = 0.024;
  float d = sdRoundBox(p, uSize * 0.5 - pad, 0.03);
  float line = smoothstep(0.0075, 0.003, abs(d));
  float glow = smoothstep(0.022, 0.0, abs(d)) * 0.45;
  // 테두리를 따라 도는 빛
  float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
  float sweep = pow(0.5 + 0.5 * sin((ang - uTime * 0.22) * 6.2831853 * 2.0), 6.0);
  float a = (line * (0.75 + 0.25 * sweep) + glow * (0.5 + sweep)) * uAmt;
  vec3 col = mix(uColor, vec3(1.0), sweep * 0.55 * line);
  gl_FragColor = vec4(col * a, a);
  #include <colorspace_fragment>
}`;

const ACCENT: Record<HighlightId, string> = {
  motivation: '#A78BFA',
  methods: '#5FD3FF',
  results_thermal_continuous: '#FF8A6B',
  results_thermal_cyclic: '#5FD3FF',
  results_etch_rate: '#A78BFA',
  results_mounting: '#FFC24D',
  results_cu_profile: '#3DDBA8',
  results_mo: '#B7C0D4',
  conclusions: '#FFD44A',
};

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
  motivation: 'intro',
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
  private readonly posterCanvas = document.createElement('canvas');
  private posterTex!: THREE.CanvasTexture;
  private readonly frameMat: THREE.ShaderMaterial;
  private readonly frame: THREE.Mesh;
  private readonly outline: THREE.LineLoop;
  private readonly charts: ReturnType<typeof buildCharts>;
  private readonly props: Prop[];
  private readonly drift: Drift;
  private readonly propFor: Record<string, Prop | undefined>;
  private readonly focus = { u0: 0, v0: 0, u1: 1, v1: 1 };
  private readonly rabbitPos = { x: 0, y: 0, hop: 0, scale: 1 };
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpM = new THREE.Matrix4();
  private revealed = false;
  private mode: 'rabbit' | 'original' = 'rabbit';
  sceneIndex = -1;
  /** 지금 강조 중인 패널(없으면 null). 2D 보기 카메라가 따라간다. */
  focusPanel: HighlightId | null = null;
  onScene: ((e: SceneEvent) => void) | null = null;

  constructor(readonly quality: Quality) {
    // 조명은 포스터에 묶는다: 어느 각도에서 봐도 소품의 명암이 포스터 기준으로 일정하다.
    const hemi = new THREE.HemisphereLight('#FFFFFF', '#B8C7E6', 1.5);
    const key = new THREE.DirectionalLight('#FFFFFF', 1.9);
    key.position.set(-0.5, 0.9, 1.4);
    const rim = new THREE.DirectionalLight('#9AD8FF', 0.7);
    rim.position.set(0.9, -0.2, 0.8);
    this.root.add(hemi, key, key.target, rim, rim.target);

    this.posterMat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        uReveal: { value: 0 },
        uOpacity: { value: 1 },
        uFocusAmt: { value: 0 },
        uFocus: { value: new THREE.Vector4(0, 0, 1, 1) },
        uAspect: { value: H },
        uTime: { value: 0 },
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

    this.frameMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: new THREE.Vector2(1, 1) }, uColor: { value: new THREE.Color('#FFD44A') }, uTime: { value: 0 }, uAmt: { value: 0 } },
      vertexShader: POSTER_VERT,
      fragmentShader: FRAME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.frameMat);
    this.frame.position.z = Z.decal;
    this.frame.renderOrder = 4;
    this.content.add(this.frame);

    // 원본 보기: 덮개를 걷고 포스터 윤곽만 남긴다.
    const og = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -H / 2, 0), new THREE.Vector3(0.5, -H / 2, 0), new THREE.Vector3(0.5, H / 2, 0), new THREE.Vector3(-0.5, H / 2, 0)]);
    this.outline = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: '#FFD44A', transparent: true, opacity: 0.9 }));
    this.outline.position.z = Z.overlay;
    this.outline.visible = false;
    this.root.add(this.outline);

    this.charts = buildCharts(quality);
    this.props = Object.values(this.charts);
    for (const p of this.props) {
      p.group.scale.setScalar(0.0001);
      this.content.add(p.group);
    }
    this.propFor = {
      plasma_basics: this.charts.chamber,
      continuous_heat: this.charts.thermo,
      cyclic_cooling: this.charts.cyclic,
      etch_rates: this.charts.etch,
      supports: this.charts.mount,
      cu_profiles: this.charts.cu,
      mo_reference: this.charts.mo,
    };

    this.drift = new Drift(quality === 'high' ? 90 : 36);
    this.content.add(this.drift.points);

    this.rabbit = new RabbitSprite(quality);
    this.rabbit.group.visible = false;
    this.rabbit.shadow.visible = false;
    this.rabbit.shadow.position.z = Z.decal;
    this.content.add(this.rabbit.shadow, this.rabbit.group);
    this.rabbit.animator.onClipEnd = (ended) => this.afterClip(ended);

    this.root.add(this.content);
  }

  async init(renderer: THREE.WebGLRenderer): Promise<void> {
    await loadPosterFonts();
    paintPoster(this.posterCanvas);
    this.posterTex = new THREE.CanvasTexture(this.posterCanvas);
    this.posterTex.colorSpace = THREE.SRGBColorSpace;
    this.posterTex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    this.posterTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.posterTex.generateMipmaps = true;
    this.posterMat.uniforms.map.value = this.posterTex;
  }

  /* ───────── 매 프레임 ───────── */

  update(dt: number, camera: THREE.Camera, viewportHeight: number): void {
    this.motion.update(dt);
    const t = this.motion.time;
    this.posterMat.uniforms.uTime.value = t;
    this.frameMat.uniforms.uTime.value = t;
    (this.posterMat.uniforms.uFocus.value as THREE.Vector4).set(this.focus.u0, this.focus.v0, this.focus.u1, this.focus.v1);

    // 강조 테두리는 focus 사각형을 따라간다.
    const fw = this.focus.u1 - this.focus.u0;
    const fh = (this.focus.v1 - this.focus.v0) * H;
    const [fx, fy] = uvToLocal((this.focus.u0 + this.focus.u1) / 2, (this.focus.v0 + this.focus.v1) / 2);
    const pad = 0.048;
    this.frame.position.x = fx;
    this.frame.position.y = fy;
    this.frame.scale.set(fw + pad, fh + pad, 1);
    (this.frameMat.uniforms.uSize.value as THREE.Vector2).set(fw + pad, fh + pad);

    if (!this.motion.paused) for (const p of this.props) p.update?.(dt, t);

    this.root.matrixWorld.decompose(this.tmpV, this.tmpQ, this.tmpS);
    this.drift.update(t, viewportHeight, this.tmpS.x);

    // 토끼: 위치 + 폴짝 뛰는 호
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

    // 소품은 위에서 아래로 차례로 튀어나온다.
    const order: Prop[] = [this.charts.chamber, this.charts.thermo, this.charts.cyclic, this.charts.etch, this.charts.mount, this.charts.cu, this.charts.mo];
    order.forEach((p, i) => {
      const delay = 0.65 + i * 0.12;
      m.to(p.group.scale, { x: 1, y: 1, z: 1 }, 0.7, { delay, ease: ease.outBack });
      m.after(delay, () => p.play(m));
    });
    m.to(this.drift.opacity, { value: 1 }, 1.6, { delay: 0.8 });

    // 토끼가 아래에서 폴짝 뛰어올라 인사한다.
    const st = STATIONS.intro;
    const [x, y] = uvToLocal(st.u, st.v);
    const rp = this.rabbitPos;
    rp.x = x;
    rp.y = y - 0.5;
    rp.scale = st.scale * 0.6;
    m.after(1.0, () => {
      this.rabbit.group.visible = true;
      this.rabbit.shadow.visible = true;
      this.rabbit.animator.play('rabbit_cheer', 1);
    });
    m.to(rp, { y, scale: st.scale }, 0.8, { delay: 1.0, ease: ease.outBack });
    m.run(0.8, (k) => (rp.hop = Math.sin(k * Math.PI) * 0.16), { delay: 1.0 });
    // 등장 중에 관람객이 이미 다른 장면을 골랐다면 덮어쓰지 않는다.
    m.after(2.2, () => {
      if (this.sceneIndex < 0) this.goScene('intro');
    });
  }

  /** 등장 연출 없이 바로 완성 상태로 (추적을 다시 잡았을 때 등). */
  showInstant(): void {
    if (this.revealed) return;
    this.revealed = true;
    this.posterMat.uniforms.uReveal.value = 1;
    for (const p of this.props) p.group.scale.setScalar(1);
    this.drift.opacity.value = 1;
    this.rabbit.group.visible = true;
    this.rabbit.shadow.visible = true;
    const st = STATIONS.intro;
    const [x, y] = uvToLocal(st.u, st.v);
    Object.assign(this.rabbitPos, { x, y, scale: st.scale, hop: 0 });
    this.goScene('intro');
  }

  /* ───────── 장면 ───────── */

  private setFocus(id: HighlightId | null): void {
    const m = this.motion;
    this.focusPanel = id;
    m.kill(this.focus);
    m.kill(this.posterMat.uniforms.uFocusAmt);
    m.kill(this.frameMat.uniforms.uAmt);
    if (!id) {
      m.to(this.posterMat.uniforms.uFocusAmt, { value: 0 }, 0.5);
      m.to(this.frameMat.uniforms.uAmt, { value: 0 }, 0.4);
      return;
    }
    const r: UvRect = PANELS[id];
    if (this.frameMat.uniforms.uAmt.value < 0.05) Object.assign(this.focus, r);
    else m.to(this.focus, r, 0.7, { ease: ease.inOutCubic });
    (this.frameMat.uniforms.uColor.value as THREE.Color).set(ACCENT[id]);
    m.to(this.posterMat.uniforms.uFocusAmt, { value: 1 }, 0.6);
    m.to(this.frameMat.uniforms.uAmt, { value: 1 }, 0.5);
  }

  private moveRabbit(sceneId: string): void {
    const st = STATIONS[sceneId] ?? STATIONS.intro;
    const [x, y] = uvToLocal(st.u, st.v);
    const rp = this.rabbitPos;
    const m = this.motion;
    const dist = Math.hypot(x - rp.x, y - rp.y);
    m.kill(rp);
    if (dist < 0.01) {
      m.to(rp, { scale: st.scale }, 0.3);
      return;
    }
    const dur = Math.min(0.95, 0.5 + dist * 0.4);
    m.to(rp, { x, y, scale: st.scale }, dur, { ease: ease.inOutCubic });
    m.run(dur, (k) => (rp.hop = Math.sin(k * Math.PI) * (0.06 + dist * 0.12)), {});
  }

  goScene(id: string, opts: { silent?: boolean } = {}): void {
    const index = scenes.findIndex((s) => s.id === id);
    if (index < 0) return;
    if (!this.revealed) this.showInstant();
    const scene = scenes[index];
    const script = sceneScripts[index];
    this.sceneIndex = index;
    this.setFocus(script.highlight);
    this.moveRabbit(id);
    const st = STATIONS[id] ?? STATIONS.intro;
    const clip = clipFor(scene.rabbit_clip);
    this.motion.kill(this.rabbit);
    this.motion.after(0.35, () => this.rabbit.animator.play(clip, st.side), this.rabbit);
    const prop = this.propFor[id];
    if (prop) {
      this.motion.kill(prop);
      this.motion.after(0.45, () => prop.play(this.motion), prop);
    }
    this.onScene?.({ id, index, total: scenes.length, title: scene.title_ko.replace(/^🐰\s*/, ''), chip: script.chip, lines: script.lines, highlight: script.highlight, silent: opts.silent ?? false });
  }

  next(): void {
    this.goScene(scenes[Math.min(scenes.length - 1, this.sceneIndex + 1)].id);
  }
  prev(): void {
    this.goScene(scenes[Math.max(0, this.sceneIndex - 1)].id);
  }

  /** 단발 클립이 끝나면: 패널을 설명 중이면 가리키는 자세, 아니면 idle. */
  private afterClip(ended: RabbitClip): void {
    if (this.sceneIndex < 0) return;
    const id = scenes[this.sceneIndex].id;
    const script = sceneScripts[this.sceneIndex];
    const st = STATIONS[id] ?? STATIONS.intro;
    if (script.highlight && script.highlight !== 'conclusions' && ended !== 'rabbit_wave') this.rabbit.animator.play('rabbit_point', st.side);
  }

  /**
   * 채팅 답변이 고른 동작을 실행한다. allowlist 밖의 값은 무시한다.
   * (서버·릴레이에서도 걸렀지만 화면 쪽에서 한 번 더 확인한다.)
   */
  runAction(action: unknown, highlight: unknown): void {
    if (!this.revealed) return;
    const hl = isHighlightId(highlight) ? highlight : null;
    if (!isSceneAction(action)) {
      if (hl) this.goScene(HIGHLIGHT_SCENE[hl], { silent: true });
      return;
    }
    const sceneId = ACTION_SCENE[action] ?? (hl ? HIGHLIGHT_SCENE[hl] : null);
    if (sceneId && sceneId !== scenes[this.sceneIndex]?.id) this.goScene(sceneId, { silent: true });
    else if (sceneId) this.propFor[sceneId]?.play(this.motion);
    if (action === 'rabbit_greet') this.rabbit.animator.play('rabbit_wave');
    else if (action === 'rabbit_surprised') this.rabbit.animator.play('rabbit_surprised');
    else if (action === 'show_heating') this.motion.after(0.5, () => this.rabbit.animator.play('rabbit_surprised'));
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

  /** 화면 좌표(NDC)로 포스터 패널을 고른다. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): HighlightId | null {
    if (!this.revealed || this.mode !== 'rabbit') return null;
    this.raycaster.setFromCamera(ndc, camera);
    return this.hitPanel();
  }

  /** 세계 좌표의 광선으로 패널을 고른다 (WebXR 의 화면 탭). */
  pickRay(origin: THREE.Vector3, direction: THREE.Vector3): HighlightId | null {
    if (!this.revealed || this.mode !== 'rabbit') return null;
    this.raycaster.set(origin, direction);
    return this.hitPanel();
  }

  private hitPanel(): HighlightId | null {
    const hit = this.raycaster.intersectObject(this.posterMesh, false)[0];
    if (!hit) return null;
    const local = this.tmpV.copy(hit.point).applyMatrix4(this.tmpM.copy(this.root.matrixWorld).invert());
    const [u, v] = localToUv(local.x, local.y);
    for (const id of Object.keys(PANELS) as HighlightId[]) {
      const r = PANELS[id];
      if (u >= r.u0 && u <= r.u1 && v >= r.v0 && v <= r.v1) return id;
    }
    return null;
  }

  /** 패널을 눌렀을 때 그 패널의 장면으로. */
  selectPanel(id: HighlightId): void {
    this.goScene(HIGHLIGHT_SCENE[id]);
  }

  /** 강조 중인 영역의 중심과 크기(포스터 단위). 없으면 포스터 전체. */
  focusBounds(): { cx: number; cy: number; w: number; h: number } {
    if (!this.focusPanel) return { cx: 0, cy: 0, w: 1, h: H };
    const [cx, cy] = rectCenter(PANELS[this.focusPanel]);
    const [w, h] = rectSize(PANELS[this.focusPanel]);
    return { cx, cy, w, h };
  }

  dispose(): void {
    this.motion.killAll();
    this.rabbit.dispose();
    this.posterTex?.dispose();
    this.posterMat.dispose();
    this.frameMat.dispose();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
  }
}
