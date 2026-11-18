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
import type { FrameTag, Measurement } from './mindarBridge';
import { WorldPosterEstimator } from './pose/filters';
import type { Intrinsics } from './pose/planarPose';
import { POSTER } from './sceneLayout';
import { type TrackState, rememberXr, xrSupported } from './support';
import { TRACKING } from './tracker';
import { type FrameSource, TrackerClient } from './trackerClient';

export interface XrCallbacks {
  onState(state: TrackState): void;
  onTap(panel: HighlightId | null): void;
  /** 사용자가 뒤로 가기 등으로 AR 세션을 끝냈을 때 */
  onEnd(): void;
  /** 이 기기에서는 AR 세션이 카메라 영상을 주지 않을 때 (AR 을 쓸 수 없다) */
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
  private bridge: TrackerClient | null = null;
  private bridgeReady = false;
  private bridgeStarting = false;
  /** 추적기가 다음 프레임을 기다리고 있으면, XR 프레임에서 카메라 영상을 읽어 넘겨준다. */
  private frameWaiter: ((src: FrameSource | null) => void) | null = null;
  private readonly world = new WorldPosterEstimator(POSTER.widthM);
  private state: TrackState = 'starting';
  private ended = false;

  // 카메라 영상 복사용 GL 자원
  private gl!: WebGL2RenderingContext;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private w = 0;
  private h = 0;
  private K: Intrinsics | null = null;
  /** 카메라 텍스처의 위아래가 뒤집혀 있는지. 구현마다 달라서, 인식이 안 되면 스스로 바꿔 본다. */
  private flip = false;
  private flipAt = 0;

  private last = 0;
  private lastMeasAt = -1e9;
  private lastPoseAt = 0;
  private measCount = 0;
  private fps = 0;
  private pbo: WebGLBuffer | null = null;
  private pendingRead: { sync: WebGLSync; tag: FrameTag; waiter: (src: FrameSource | null) => void; frames: number } | null = null;
  private readLag = 0;
  private viewportScale = 1;
  private readonly dts = new Float32Array(90).fill(33);
  private dtIndex = 0;
  /** 막힘이 없을 때의 프레임 간격 (ms). 1000 / nominalMs 가 이 세션의 프레임률 상한이다. */
  private nominalMs = 33.3;
  private slowFor = 0;
  private fastFor = 0;
  private slowFrames = 0;
  private totalFrames = 0;
  private camSpeed = 0;
  private lastSafetyAt = 0;
  private readonly prevCam = new THREE.Vector3();
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
      track: s ? `${s.hz.toFixed(1)}Hz pts ${s.inliers}/${s.points} rms ${s.rms.toFixed(1)}px` : '-',
      engine: s ? `${this.bridge!.mode} ${s.ms.toFixed(0)}ms/frame, detect ${s.detects} miss ${s.misses}` : '-',
      meas: this.measCount,
      world: `n ${this.world.count} keys ${this.world.keyframes} ${this.world.converged ? 'converged' : 'converging'} resets ${this.world.resets}`,
      width: `${(e.width * 100).toFixed(1)}cm`,
      fps: `${this.fps.toFixed(0)} (cap ${(1000 / this.nominalMs).toFixed(0)}) @x${this.viewportScale.toFixed(2)} slow ${this.slowFrames}/${this.totalFrames}`,
      read: `async, ${this.readLag.toFixed(1)} frames`,
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

    // MSAA 는 끈다: 폰의 높은 화소 밀도에서는 차이가 거의 안 보이는데 채우는 비용은 크다.
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.xr.enabled = true;
    // 기본 해상도로 버퍼를 잡고, 실제로 그리는 영역은 부하에 따라 매 프레임 조절한다(아래 viewportScale).
    this.renderer.xr.setFramebufferScaleFactor(1);
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

    const ref = this.renderer.xr.getReferenceSpace();
    const vp = ref ? frame.getViewerPose(ref) : null;
    const view = vp?.views?.[0];
    const root = this.stage.root;

    if (view) {
      // 그리는 해상도를 부하에 맞춘다. 브라우저가 권장값을 주면 그것도 반영한다.
      // (요청은 다음 프레임부터 적용된다. 버퍼를 다시 만들지 않으므로 끊김이 없다.)
      if (typeof view.requestViewportScale === 'function') {
        const rec = typeof view.recommendedViewportScale === 'number' ? view.recommendedViewportScale : 1;
        view.requestViewportScale(Math.max(0.5, Math.min(this.viewportScale, rec)));
      }
      this.lastPoseAt = now;
      this.prevCam.copy(this.camPos);
      this.m4.fromArray(view.transform.matrix).decompose(this.camPos, this.camQuat, this.camScale);
      // 카메라가 움직이는 속도 (m/s). 움직이는 동안에는 관측을 촘촘히 한다.
      if (dt > 0) this.camSpeed += (this.prevCam.distanceTo(this.camPos) / dt - this.camSpeed) * 0.2;
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

    // 카메라 영상은 추적기가 달라고 할 때만 읽는다 (GPU → CPU 읽기는 비싸다).
    if (view?.camera) {
      try {
        if (!this.bridge && !this.bridgeStarting) this.bootstrap(view);
        else if (this.pendingRead) this.finishRead(now);
        else if (this.frameWaiter) this.beginRead(view, now);
      } catch (e) {
        console.warn('camera image grab failed', e);
      }
    }

    // 이 기기의 AR 세션이 낼 수 있는 프레임률(상한)을 잰다.
    // Android 의 WebXR AR 은 ARCore 카메라 프레임에 맞춰 돌기 때문에 보통 초당 30 이 상한이다.
    // 상한을 60 으로 가정하면 "항상 느리다"고 오판해서 해상도만 깎게 된다(실제로 그랬다).
    if (dt > 0.002) {
      this.dts[this.dtIndex++ % this.dts.length] = dt * 1000;
      if (this.dtIndex % 45 === 0 && this.dtIndex >= this.dts.length) {
        const sorted = Array.from(this.dts).sort((a, b) => a - b);
        this.nominalMs = sorted[Math.floor(sorted.length * 0.2)]; // 빠른 쪽 20% 지점 = 막힘 없을 때의 간격
      }
    }
    const cap = 1000 / this.nominalMs;
    this.totalFrames++;
    if (dt * 1000 > this.nominalMs * 1.6) this.slowFrames++;
    // 상한에 못 미칠 때만 그리는 영역을 줄이고, 상한에 닿아 있으면 되돌린다.
    if (this.state === 'tracking' && now - this.startedAt > 8000 && this.dtIndex >= this.dts.length) {
      this.slowFor = this.fps < cap * 0.85 ? this.slowFor + dt : 0;
      this.fastFor = this.fps > cap * 0.94 ? this.fastFor + dt : 0;
      if (this.slowFor > 1.5 && this.viewportScale > 0.6) {
        this.viewportScale = Math.max(0.6, this.viewportScale - 0.1);
        this.slowFor = 0;
      } else if (this.fastFor > 3 && this.viewportScale < 1) {
        this.viewportScale = Math.min(1, this.viewportScale + 0.1);
        this.fastFor = 0;
      }
    }

    // 안전장치: 카메라 영상이 아예 오지 않으면(8초) AR 을 쓸 수 없는 기기로 보고 알린다.
    // 포스터를 아직 못 찾은 것은 실패가 아니다(관람객이 아직 포스터를 비추지 않았을 뿐일 수 있다). 계속 찾는다.
    // 예전에는 30초 안에 못 찾으면 카메라 영상 방식으로 넘겨 버려서, 새 기기가 그 방식으로 굳는 일이 있었다.
    if (!this.gaveUp && this.w === 0 && now - this.startedAt > 8000) {
      this.gaveUp = true;
      this.cb.onGiveUp('no-camera-image');
      return;
    }

    // 한참 인식이 안 되면 영상이 뒤집혀 들어오는 구현일 수 있다 → 뒤집어 본다.
    if (!this.world.locked && this.bridgeReady && now - Math.max(this.flipAt, this.lastMeasAt) > 4000) {
      this.flip = !this.flip;
      this.flipAt = now;
    }
  }

  /** 브라우저가 알려 주는 실제 내부 파라미터 (카메라 영상은 이 뷰의 투영과 정렬돼 있다). */
  private intrinsicsOf(view: Any): Intrinsics {
    const P = view.projectionMatrix as Float32Array;
    return { fx: (P[0] * this.w) / 2, fy: (P[5] * this.h) / 2, cx: ((1 - P[8]) * this.w) / 2, cy: ((1 + P[9]) * this.h) / 2 };
  }

  /** 첫 카메라 프레임에서 영상 크기와 내부 파라미터를 알아내고 추적기를 띄운다. */
  private bootstrap(view: Any): void {
    this.bridgeStarting = true;
    this.setupCopy(view.camera.width, view.camera.height);
    this.K = this.intrinsicsOf(view);
    void this.startBridge();
  }

  /**
   * 카메라 영상 읽기 1단계: 텍스처를 작은 버퍼로 복사하고, GPU 에 "픽셀을 PBO 로 옮겨 달라"고만 해 둔다.
   * gl.readPixels 를 곧바로 배열로 받으면 GPU 가 끝날 때까지 화면 스레드가 멈춘다(프레임이 끊긴다).
   * PBO 로 받으면 기다리지 않고 다음 프레임들에서 준비됐는지만 확인하면 된다.
   */
  private beginRead(view: Any, now: number): void {
    const gl = this.gl;
    const tex: WebGLTexture | null = this.binding.getCameraImage(view.camera);
    if (!tex) return;
    const waiter = this.frameWaiter;
    if (!waiter) return;
    this.frameWaiter = null;
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
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); // 반드시 풀어 둔다: 묶인 채로 두면 three.js 의 텍스처 업로드가 깨진다
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // three.js 가 알고 있는 GL 상태와 어긋나지 않게 초기화한다.
    this.renderer.resetState();

    const K = this.intrinsicsOf(view);
    if (this.K && (Math.abs(K.fx / this.K.fx - 1) > 0.01 || Math.abs(K.cx - this.K.cx) > 1 || Math.abs(K.cy - this.K.cy) > 1)) {
      this.K = K;
      this.bridge?.setIntrinsics(K);
    }
    const tag: FrameTag = { time: now, camPos: this.camPos.clone(), camQuat: this.camQuat.clone() };
    if (!sync) {
      waiter(null);
      return;
    }
    this.pendingRead = { sync, tag, waiter, frames: 0 };
  }

  /** 카메라 영상 읽기 2단계: GPU 가 다 옮겼으면 PBO 에서 꺼내 추적기에 넘긴다. */
  private finishRead(_now: number): void {
    const gl = this.gl;
    const pr = this.pendingRead!;
    pr.frames++;
    const status = gl.clientWaitSync(pr.sync, 0, 0);
    const ready = status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED;
    if (!ready && status !== gl.WAIT_FAILED && pr.frames < 8) return; // 아직이면 다음 프레임에 다시 본다
    this.pendingRead = null;
    gl.deleteSync(pr.sync);
    if (status === gl.WAIT_FAILED) {
      pr.waiter(null);
      return;
    }
    const size = this.w * this.h * 4;
    // 워커가 돌려준 버퍼가 있으면 다시 쓴다.
    let pixels = this.bridge?.spare ?? null;
    if (this.bridge) this.bridge.spare = null;
    if (!pixels || pixels.byteLength !== size) pixels = new Uint8Array(size);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.readLag += (pr.frames - this.readLag) * 0.2;
    pr.waiter({ pixels, tag: pr.tag });
  }

  private setupCopy(camW: number, camH: number): void {
    const gl = this.gl;
    const scale = SHORT_SIDE / Math.min(camW, camH);
    this.w = Math.max(2, Math.round(camW * scale));
    this.h = Math.max(2, Math.round(camH * scale));
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      return sh;
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
    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.w * this.h * 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.renderer.resetState();
  }

  /** 고정된 포스터가 지금 카메라 화면 안(조금 넉넉하게)에 들어와 있는가. */
  private posterInView(): boolean {
    if (!this.K) return true;
    const e = this.world.estimate;
    const p = this.tv.copy(e.position).sub(this.camPos).applyQuaternion(this.tq.copy(this.camQuat).invert());
    if (p.z > -0.05) return false;
    const u = this.K.cx + (this.K.fx * p.x) / -p.z;
    const v = this.K.cy - (this.K.fy * p.y) / -p.z;
    return u > -0.35 * this.w && u < 1.35 * this.w && v > -0.35 * this.h && v < 1.35 * this.h;
  }

  private async startBridge(): Promise<void> {
    this.bridge = new TrackerClient({
      width: this.w,
      height: this.h,
      intrinsics: this.K!,
      targetUrl: TRACKING.targetUrl,
      getFrame: () => {
        // 추정이 수렴했고 포스터가 화면 밖이면 추적할 것이 없다. 그래도 추정이 틀렸을 가능성에 대비해
        // 1초에 한 번은 프레임을 넘겨 확인한다.
        if (this.world.converged && !this.posterInView() && performance.now() - this.lastSafetyAt < 1000) return null;
        this.lastSafetyAt = performance.now();
        return new Promise<FrameSource | null>((resolve) => {
          this.frameWaiter = resolve;
          window.setTimeout(() => {
            if (this.frameWaiter === resolve) {
              this.frameWaiter = null;
              resolve(null);
            }
          }, 600);
        });
      },
      // 크기·거리까지 수렴하기 전, 또는 폰이 움직이는 중에는 촘촘히 관측해 바로잡는다(초당 20번).
      // 수렴했고 가만히 있을 때만 느슨하게(초당 7번).
      // 화면이 밀리고 있으면 한 단계 더 느슨하게 한다(추적 스레드도 같은 GPU 를 쓴다).
      intervalMs: () => (this.world.converged && this.camSpeed < 0.08 ? 150 : 50) * (this.fps > 0 && this.fps < (1000 / this.nominalMs) * 0.8 ? 1.6 : 1),
      predict: (tag, outP, outQ) => {
        if (!this.world.locked || !tag.camPos || !tag.camQuat) return false;
        const e = this.world.estimate;
        const inv = this.tq.copy(tag.camQuat).invert();
        outQ.copy(inv).multiply(e.quaternion);
        outP.copy(e.position).sub(tag.camPos).applyQuaternion(inv).multiplyScalar(1 / e.width);
        return true;
      },
      canResume: () => true,
      onMeasurement: (m: Measurement) => {
        if (this.measCount++ === 0) rememberXr('ok');
        this.lastMeasAt = m.tag.time;
        if (m.tag.camPos && m.tag.camQuat) this.world.add(m.tag.camPos, m.tag.camQuat, m.p, m.q, m.tag.time);
      },
    });
    try {
      await this.bridge.init();
      this.bridge.start();
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

