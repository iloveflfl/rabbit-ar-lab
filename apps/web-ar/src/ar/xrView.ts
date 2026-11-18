/**
 * AR 보기 (WebXR 경로): Android Chrome + ARCore 에서 동작한다. 가능한 기기에서는 이 경로가 1순위다.
 *
 * 왜 더 나은가
 *   ARCore 가 카메라 영상과 관성 센서(자이로·가속도계)를 융합해 "폰이 방 안 어디에 어떤 각도로 있는지"를
 *   실제 길이 단위로 추적한다. 우리는 그 위에서 포스터가 세계의 어디에 붙어 있는지만 알아내면 된다.
 *   포스터는 움직이지 않으므로 여러 프레임의 관측을 모아 하나의 자세로 굳힐 수 있고(떨림이 사라진다),
 *   한번 굳으면 포스터가 화면 밖으로 나가거나 가까이 다가가도 콘텐츠가 제자리에 붙어 있다.
 *
 * 흐름
 *   XR 프레임 → 카메라 영상 텍스처(camera-access) → 작은 캔버스로 복사 → MindAR 특징점 추적
 *   → 자체 자세 풀이(브라우저가 알려 주는 실제 내부 파라미터) → 카메라 세계 자세와 합쳐 세계 좌표로
 *   → WorldPosterEstimator 가 위치·방향·실제 크기를 추정 → 그 자리에 스테이지를 놓는다.
 *
 * 검증 상태: 이 파일의 WebXR 호출부는 개발 PC 에서 실행해 볼 수 없었다(ARCore 기기 필요).
 * 추정기와 자세 풀이는 단위 테스트와 모의 카메라(?mode=simworld)로 확인했다.
 * 시작에 실패하면 main.ts 가 카메라 영상 경로(tracker.ts)로 내려간다.
 */
import * as THREE from 'three';
import type { HighlightId } from '@rabbit/shared';
import type { LabStage } from '../stage/stage';
import { type FrameTag, type Measurement, MindarBridge } from './mindarBridge';
import { WorldPosterEstimator } from './pose/filters';
import type { Intrinsics } from './pose/planarPose';
import { POSTER } from './sceneLayout';
import { type TrackState, rememberXr, xrSupported } from './support';
import { TRACKING } from './tracker';

export interface XrCallbacks {
  onState(state: TrackState): void;
  onTap(panel: HighlightId | null): void;
  /** 사용자가 뒤로 가기 등으로 AR 세션을 끝냈을 때 */
  onEnd(): void;
  /** 이 기기에서는 WebXR 경로로 포스터를 찾지 못한다고 판단했을 때 (카메라 영상 경로로 바꿔야 한다) */
  onGiveUp(reason: string): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const BLIT_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
uniform float uFlip;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  vUv = vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlip));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
const BLIT_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 color;
void main() { color = texture(uTex, vUv); }`;

/** 추적용으로 줄인 카메라 영상의 짧은 변 길이 */
const SHORT_SIDE = 480;

export class XrArView {
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 60);
  private session: Any = null;
  private binding: Any = null;
  private bridge: MindarBridge | null = null;
  private bridgeReady = false;
  private readonly world = new WorldPosterEstimator(POSTER.widthM);
  private state: TrackState = 'starting';
  private ended = false;

  // 카메라 영상 복사용 GL 자원
  private gl!: WebGL2RenderingContext;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private pixels: Uint8Array | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;
  private K: Intrinsics | null = null;
  /** 카메라 텍스처의 위아래가 뒤집혀 있는지. 구현마다 달라서, 인식이 안 되면 스스로 바꿔 본다. */
  private flip = false;
  private flipAt = 0;

  private tag: FrameTag = { time: 0 };
  private frameNo = 0;
  private last = 0;
  private lastMeasAt = -1e9;
  private lastPoseAt = 0;
  private measCount = 0;
  private fps = 0;
  private startedAt = 0;
  private gaveUp = false;
  private readonly camPos = new THREE.Vector3();
  private readonly camQuat = new THREE.Quaternion();
  private readonly camScale = new THREE.Vector3();
  private readonly m4 = new THREE.Matrix4();
  private readonly tq = new THREE.Quaternion();
  private readonly tv = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(private readonly stage: LabStage, private readonly cb: XrCallbacks) {}

  static supported(): Promise<boolean> {
    return xrSupported();
  }

  get debug(): Record<string, string | number> {
    const s = this.bridge?.stats;
    const e = this.world.estimate;
    return {
      mode: 'webxr (ARCore)',
      state: this.state,
      camImg: this.w ? `${this.w}x${this.h} flip ${this.flip ? 1 : 0}` : 'waiting',
      fov: this.K ? `${((2 * Math.atan(this.h / 2 / this.K.fy) * 180) / Math.PI).toFixed(1)}° v` : '-',
      track: s ? `${s.trackHz.toFixed(0)}Hz pts ${s.inliers}/${s.points} rms ${s.rms.toFixed(1)}px` : '-',
      meas: this.measCount,
      world: `n ${this.world.count} keys ${this.world.keyframes}`,
      width: `${(e.width * 100).toFixed(1)}cm`,
      fps: this.fps.toFixed(0),
    };
  }

  private setState(s: TrackState): void {
    if (s === this.state) return;
    this.state = s;
    this.cb.onState(s);
  }

  /** 반드시 사용자 동작(버튼 탭) 직후에 불러야 한다. overlayRoot: 채팅·HUD 가 들어 있는 HTML 요소. */
  async start(overlayRoot: HTMLElement): Promise<void> {
    this.cb.onState('starting');
    const xr = (navigator as Any).xr;
    // camera-access 가 없으면 포스터를 찾을 수 없으므로 필수로 요구한다(없으면 여기서 실패 → 영상 경로로 전환).
    this.session = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'camera-access'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlayRoot },
    });
    const session = this.session;

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);
    this.gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.binding = new (window as Any).XRWebGLBinding(session, this.gl);

    await this.stage.init(this.renderer);
    this.stage.root.visible = false;
    this.scene.add(this.stage.root, this.camera);

    session.addEventListener('end', () => {
      if (!this.ended) {
        this.ended = true;
        this.cleanup();
        this.cb.onEnd();
      }
    });
    session.addEventListener('select', (ev: Any) => this.onSelect(ev));
    // HTML 버튼·입력창을 누른 것은 3D 선택으로 넘기지 않는다.
    overlayRoot.addEventListener('beforexrselect', (ev) => {
      const t = ev.target as Element | null;
      if (t?.closest('#bottom, .hud')) ev.preventDefault();
    });

    this.last = performance.now();
    this.startedAt = this.last;
    this.flipAt = this.last;
    this.setState('searching');
    this.renderer.setAnimationLoop((_t: number, frame: Any) => this.onFrame(frame));
  }

  private onFrame(frame: Any): void {
    if (!frame || this.ended) return;
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
    this.frameNo++;

    const ref = this.renderer.xr.getReferenceSpace();
    const vp = ref ? frame.getViewerPose(ref) : null;
    const view = vp?.views?.[0];
    const root = this.stage.root;

    if (view) {
      this.lastPoseAt = now;
      this.m4.fromArray(view.transform.matrix).decompose(this.camPos, this.camQuat, this.camScale);
    }

    // 포스터는 세계에 고정: 추정한 자세에 스테이지를 놓는다.
    const pose = this.world.pose(dt);
    const poseOk = now - this.lastPoseAt < 800;
    if (pose && this.world.locked && poseOk) {
      root.position.copy(pose.position);
      root.quaternion.copy(pose.quaternion);
      root.scale.setScalar(pose.width);
      if (this.state !== 'tracking') {
        root.visible = true;
        this.stage.setTracking(true);
        if (!this.stage.isRevealed) this.stage.reveal();
        this.setState('tracking');
      }
    } else if (this.state === 'tracking' && !poseOk) {
      // ARCore 가 폰 위치를 잃었다 (카메라가 가려짐, 너무 어두움, 급하게 움직임)
      root.visible = false;
      this.stage.setTracking(false);
      this.setState('lost');
    }

    const base = this.renderer.xr.getBaseLayer?.() as Any;
    this.stage.update(dt, this.renderer.xr.getCamera(), base?.framebufferHeight ?? 1600);
    this.renderer.render(this.scene, this.camera);

    // 카메라 영상을 추적기로 넘긴다 (두 프레임에 한 번이면 충분하다).
    if (view?.camera && this.frameNo % 2 === 0) {
      try {
        this.grab(view, now);
      } catch (e) {
        console.warn('camera image grab failed', e);
      }
    }

    // 안전장치: 이 경로는 실기기에서 검증되지 않았다. 카메라 영상이 아예 안 오거나(5초),
    // 영상은 오는데 한 번도 인식하지 못하면(25초) 포기하고 카메라 영상 경로로 넘긴다.
    if (!this.gaveUp && this.measCount === 0) {
      const waited = now - this.startedAt;
      if ((this.w === 0 && waited > 5000) || waited > 25000) {
        this.gaveUp = true;
        this.cb.onGiveUp(this.w === 0 ? 'no-camera-image' : 'no-detection');
        return;
      }
    }

    // 한참 인식이 안 되면 영상이 뒤집혀 들어오는 구현일 수 있다 → 뒤집어 본다.
    if (!this.world.locked && this.bridgeReady && now - Math.max(this.flipAt, this.lastMeasAt) > 4000) {
      this.flip = !this.flip;
      this.flipAt = now;
    }
  }

  private grab(view: Any, now: number): void {
    const gl = this.gl;
    const cam = view.camera;
    const tex: WebGLTexture | null = this.binding.getCameraImage(cam);
    if (!tex) return;
    if (!this.canvas) this.setupCopy(cam.width, cam.height);
    const w = this.w;
    const h = this.h;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(this.prog!, 'uTex'), 0);
    gl.uniform1f(gl.getUniformLocation(this.prog!, 'uFlip'), this.flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // three.js 가 알고 있는 GL 상태와 어긋나지 않게 초기화한다.
    this.renderer.resetState();

    this.ctx!.putImageData(new ImageData(new Uint8ClampedArray(this.pixels!.buffer as ArrayBuffer), w, h), 0, 0);
    this.tag = { time: now, camPos: this.camPos.clone(), camQuat: this.camQuat.clone() };

    // 브라우저가 알려 주는 실제 내부 파라미터 (카메라 영상은 이 뷰의 투영과 정렬돼 있다).
    const P = view.projectionMatrix as Float32Array;
    const K: Intrinsics = { fx: (P[0] * w) / 2, fy: (P[5] * h) / 2, cx: ((1 - P[8]) * w) / 2, cy: ((1 + P[9]) * h) / 2 };
    if (!this.K) {
      this.K = K;
      void this.startBridge();
    } else if (Math.abs(K.fx / this.K.fx - 1) > 0.01 || Math.abs(K.cx - this.K.cx) > 1 || Math.abs(K.cy - this.K.cy) > 1) {
      this.K = K;
      if (this.bridgeReady) this.bridge!.setIntrinsics(K);
    }
  }

  private setupCopy(camW: number, camH: number): void {
    const gl = this.gl;
    const scale = SHORT_SIDE / Math.min(camW, camH);
    this.w = Math.max(2, Math.round(camW * scale));
    this.h = Math.max(2, Math.round(camH * scale));
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, BLIT_VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, BLIT_FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    this.prog = prog;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.pixels = new Uint8Array(this.w * this.h * 4);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  private async startBridge(): Promise<void> {
    this.bridge = new MindarBridge({
      width: this.w,
      height: this.h,
      intrinsics: this.K!,
      targetUrl: TRACKING.targetUrl,
      grab: () => this.tag,
      predict: (tag, outP, outQ) => {
        if (!this.world.locked || !tag.camPos || !tag.camQuat) return false;
        const e = this.world.estimate;
        const inv = this.tq.copy(tag.camQuat).invert();
        outQ.copy(inv).multiply(e.quaternion);
        outP.copy(e.position).sub(tag.camPos).applyQuaternion(inv).multiplyScalar(1 / e.width);
        return true;
      },
      onMeasurement: (m: Measurement) => {
        if (this.measCount++ === 0) rememberXr('ok');
        this.lastMeasAt = m.tag.time;
        if (m.tag.camPos && m.tag.camQuat) this.world.add(m.tag.camPos, m.tag.camQuat, m.p, m.q, m.tag.time);
      },
    });
    try {
      await this.bridge.init();
      this.bridge.start(this.canvas!);
      this.bridgeReady = true;
    } catch (e) {
      console.error('poster tracker init failed', e);
    }
  }

  private onSelect(ev: Any): void {
    const ref = this.renderer.xr.getReferenceSpace();
    const pose = ref && ev.frame?.getPose(ev.inputSource.targetRaySpace, ref);
    if (!pose) return;
    const t = pose.transform;
    this.tv.set(t.position.x, t.position.y, t.position.z);
    this.tq.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
    this.dir.set(0, 0, -1).applyQuaternion(this.tq);
    this.cb.onTap(this.state === 'tracking' ? this.stage.pickRay(this.tv, this.dir) : null);
  }

  private cleanup(): void {
    this.renderer?.setAnimationLoop(null);
    this.bridge?.stop();
    this.bridge = null;
    this.scene.remove(this.stage.root);
    this.renderer?.dispose();
  }

  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.cleanup();
    try {
      void this.session?.end();
    } catch {
      /* 이미 끝남 */
    }
  }
}

