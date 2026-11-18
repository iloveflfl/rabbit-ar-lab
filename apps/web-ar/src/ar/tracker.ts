/**
 * AR 보기 (카메라 영상 경로): WebXR 을 쓸 수 없는 기기(iOS Safari, 인앱 브라우저 등)에서 동작한다.
 *
 *   영상 프레임 → MindAR 특징점 추적 → 자체 자세 풀이(실제 초점거리) → 자이로 융합 필터 → 렌더
 *
 * - 추적 대상은 포스터 그림 자체다(QR 이 아니다).
 * - 초점거리는 처음에 흔한 값으로 시작하고, 포스터를 여러 각도에서 보는 동안 스스로 보정해 저장한다.
 * - 방향 센서가 있으면 회전을 세계 기준으로 붙들어 떨림을 없애고, 폰을 돌릴 때 센서 속도로 따라간다.
 * - 추적을 놓치면 잠깐(graceMs) 센서만으로 자세를 이어 가다가 숨기고, 놓쳤다고 화면에 알린다.
 *
 * 개발용 world 모드: 모의 카메라가 "세계 추적(ARCore 역할)"까지 흉내 내어, WebXR 경로와 같은
 * 세계 고정 추정기를 실기기 없이 시험한다.
 */
import * as THREE from 'three';
import type { HighlightId } from '@rabbit/shared';
import type { LabStage } from '../stage/stage';
import { type FrameTag, type Measurement, priorIntrinsics, projectionFromIntrinsics } from './mindarBridge';
import { FocalCalibrator, GyroPoseFilter, WorldPosterEstimator } from './pose/filters';
import type { Intrinsics } from './pose/planarPose';
import { POSTER } from './sceneLayout';
import { DeviceOrientationSource, NoOrientationSource, type OrientationSource } from './sensors';
import { SimCamera } from './simCamera';
import { CameraError, type TrackState } from './support';
import { type FrameSource, TrackerClient } from './trackerClient';

export { CameraError, type TrackState };


export interface ArCallbacks {
  onState(state: TrackState): void;
  onTap(panel: HighlightId | null): void;
}

export const TRACKING = {
  targetUrl: 'assets/targets/poster.mind',
  /** 추적을 놓친 뒤 센서만으로 자세를 이어 가는 시간 */
  graceMs: 450,
  /** 카메라 영상이 센서보다 늦는 시간 (ms). 폰을 돌릴 때 덮개가 앞서거나 끌리면 조정한다. */
  cameraLatencyMs: 60,
  /** 이보다 빨리 돌 때의 관측은 흐려져 있으므로 버린다 (도/초) */
  maxRateDegPerSec: 140,
  /** 초기 시야각 가정 (긴 변, 도). 자동 보정 전까지 쓴다. */
  priorFovDeg: 65,
} as const;

const RATIO_STEPS = [2, 1.6, 1.3, 1];
const LAT_CANDIDATES = [0, 20, 40, 60, 80, 100, 120, 140, 160];

export interface ArStartOptions {
  simulate?: boolean;
  /** 모의 카메라에서 세계 추적까지 흉내 낸다 (WebXR 경로의 추정기 시험용) */
  simWorld?: boolean;
  /** 자이로 융합을 끈다 (비교 시험용) */
  noGyro?: boolean;
  /** 초점거리 자동 보정을 끈다 (비교 시험용) */
  noCalibration?: boolean;
  /** 추적을 메인 스레드에서 돌린다 (비교 시험용) */
  noWorker?: boolean;
  /** 영상 프레임의 촬영 시각을 쓰지 않고 고정 지연값으로 센서를 맞춘다 (비교 시험용) */
  noFrameClock?: boolean;
  latencyMs?: number;
}

export class ArView {
  private video!: HTMLVideoElement;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.03, 80);
  private bridge: TrackerClient | null = null;
  private stream: MediaStream | null = null;
  private sim: SimCamera | null = null;
  private orientation: OrientationSource = new NoOrientationSource();
  private readonly filter = new GyroPoseFilter();
  private world: WorldPosterEstimator | null = null;
  private calibrator: FocalCalibrator | null = null;
  private K!: Intrinsics;
  private vw = 0;
  private vh = 0;
  private latency: number = TRACKING.cameraLatencyMs;
  private raf = 0;
  private running = false;
  private last = 0;
  private state: TrackState = 'starting';
  private vfc: ((cb: (now: number, meta: { captureTime?: number }) => void) => number) | null = null;
  private frameWaiter: ((f: FrameSource) => void) | null = null;
  private displayCapture = 0;
  private captureValid = false;
  private captureLag = 0;
  private lastMeasAt = -1e9;
  private lastLostAt = -1e9;
  private trackingSince = 0;
  private streak = 0;
  private lastCalibAt = 0;
  private calibratedCount = 0;
  private useGyro = true;
  private autoLatency = true;
  private readonly latCost = LAT_CANDIDATES.map(() => 0);
  private readonly latPrev: THREE.Quaternion[] = [];
  private latSamples = 0;
  private frameMs = 16;
  private slowFor = 0;
  private ratioStep = 0;
  private slowFrames = 0;
  private totalFrames = 0;
  private cameraFps = 0;
  private lastVideoFrameAt = 0;
  private readonly ndc = new THREE.Vector2();
  private readonly qwc = new THREE.Quaternion();
  private readonly tp = new THREE.Vector3();
  private readonly tq = new THREE.Quaternion();
  private readonly ID = new THREE.Quaternion();
  private readonly onResize = () => this.layout();

  constructor(private readonly container: HTMLElement, private readonly stage: LabStage, private readonly cb: ArCallbacks) {}

  get simCamera(): SimCamera | null {
    return this.sim;
  }
  get glCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }
  get videoElement(): HTMLVideoElement {
    return this.video;
  }
  get trackState(): TrackState {
    return this.state;
  }
  get activeTarget(): number {
    return this.bridge?.stats.target ?? -1;
  }
  /** 화면에 그리는 진단 정보 */
  get debug(): Record<string, string | number> {
    const s = this.bridge?.stats;
    const fov = this.K ? (2 * Math.atan(Math.max(this.vw, this.vh) / 2 / this.K.fx) * 180) / Math.PI : 0;
    const d: Record<string, string | number> = {
      mode: this.world ? 'video+world(sim)' : 'video',
      state: this.state,
      video: `${this.vw}x${this.vh}`,
      fov: `${fov.toFixed(1)}° (${this.calibratedCount ? 'calibrated' : 'prior'})`,
      gyro: this.useGyro && this.orientation.available ? `on ${this.orientation.rateDegPerSec.toFixed(0)}°/s` : 'off',
      sync: this.captureValid ? `frame clock (${this.captureLag.toFixed(0)}ms)` : `guess ${this.latency.toFixed(0)}ms`,
      track: s ? `${s.hz.toFixed(0)}Hz pts ${s.inliers}/${s.points} rms ${s.rms.toFixed(1)}px` : '-',
      engine: s ? `${this.bridge!.mode} ${s.ms.toFixed(0)}ms/frame, detect ${s.detects} miss ${s.misses}` : '-',
      innov: `${this.filter.lastAngleDeg.toFixed(2)}° ${(this.filter.lastShift * 100).toFixed(2)}%`,
      fps: `${(1000 / this.frameMs).toFixed(0)} @x${RATIO_STEPS[this.ratioStep]} slow ${this.slowFrames}/${this.totalFrames}`,
      camera: this.cameraFps ? `${this.cameraFps.toFixed(0)}fps` : '-',
    };
    if (this.world) d.world = `n ${this.world.count} keys ${this.world.keyframes} width ${(this.world.estimate.width * 100).toFixed(1)}cm ${this.world.converged ? 'converged' : 'converging'} resets ${this.world.resets}`;
    return d;
  }

  private setState(s: TrackState): void {
    if (s === this.state) return;
    this.state = s;
    this.cb.onState(s);
  }

  async start(opts: ArStartOptions = {}): Promise<void> {
    this.cb.onState('starting');
    this.latency = opts.latencyMs ?? TRACKING.cameraLatencyMs;
    this.autoLatency = opts.latencyMs === undefined;
    this.useGyro = !opts.noGyro;
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('autoplay', '');
    this.video.muted = true;
    this.video.className = 'ar-video';
    this.container.appendChild(this.video);

    if (opts.simulate) {
      this.sim = new SimCamera();
      await this.sim.start();
      this.stream = this.sim.stream;
      if (this.useGyro) this.orientation = this.sim.orientationSource();
    } else {
      if (!window.isSecureContext) throw new CameraError('insecure', '카메라는 HTTPS 주소에서만 쓸 수 있어요.');
      if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unavailable', '이 브라우저에서는 카메라를 쓸 수 없어요.');
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // 초당 60프레임을 요청한다(지원하지 않으면 기기가 가능한 값으로 준다). 카메라 영상 자체가 부드러워진다.
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
        });
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', '카메라 권한이 거부됐어요.');
        if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('unavailable', '쓸 수 있는 카메라를 찾지 못했어요.');
        throw new CameraError('unknown', '카메라를 켜지 못했어요.');
      }
      if (this.useGyro) {
        const src = new DeviceOrientationSource();
        src.start();
        this.orientation = src;
      }
    }
    this.video.srcObject = this.stream;
    await new Promise<void>((res, rej) => {
      this.video.onloadedmetadata = () => res();
      this.video.onerror = () => rej(new CameraError('unknown', '카메라 영상을 받지 못했어요.'));
    });
    await this.video.play().catch(() => {});
    const vw = (this.vw = this.video.videoWidth);
    const vh = (this.vh = this.video.videoHeight);
    this.video.width = vw;
    this.video.height = vh;

    // 초점거리: 세계 모드(모의)는 참값을 받고, 그 밖에는 저장해 둔 보정값 → 없으면 흔한 값으로 시작한다.
    const prior = priorIntrinsics(vw, vh, TRACKING.priorFovDeg);
    if (opts.simWorld && this.sim) {
      this.K = this.sim.intrinsics();
      this.world = new WorldPosterEstimator(POSTER.widthM);
    } else {
      this.K = prior;
      const saved = opts.noCalibration ? null : loadFocal(vw, vh);
      if (saved) {
        this.K = { ...prior, fx: saved, fy: saved };
        this.calibratedCount = 1;
      }
      if (!opts.noCalibration) this.calibrator = new FocalCalibrator(prior.cx, prior.cy, prior.fx);
    }

    // 화소 밀도가 높은 화면(대부분의 폰)에서는 MSAA 를 끈다: 비용은 크고 차이는 거의 안 보인다.
    const msaa = this.stage.quality === 'high' && (window.devicePixelRatio || 1) < 2;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: msaa, powerPreference: 'high-performance', preserveDrawingBuffer: import.meta.env.DEV });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'ar-canvas';
    this.container.appendChild(this.renderer.domElement);
    this.camera.matrixAutoUpdate = true;
    this.applyProjection();
    this.scene.add(this.camera);

    await this.stage.init(this.renderer);
    this.stage.root.visible = false;
    this.scene.add(this.stage.root);

    const sim = this.sim;
    this.bridge = new TrackerClient({
      width: vw,
      height: vh,
      intrinsics: this.K,
      targetUrl: TRACKING.targetUrl,
      useWorker: !opts.noWorker,
      getFrame: () => this.nextFrame(),
      // 영상 추적은 센서/세계 추적을 "바로잡는" 역할이므로 상태에 따라 주기를 낮춘다.
      intervalMs: () => {
        const b = this.bridge;
        const inWorker = b?.mode === 'worker';
        // 한 프레임 처리에 걸리는 시간보다 촘촘히 먹이지 않는다 (느린 기기에서 밀리지 않게).
        // 화면이 밀리고 있으면 추적을 덜 돌린다: 추적 스레드도 같은 GPU 를 쓰기 때문이다.
        const load = this.frameMs > 30 ? 2.2 : this.frameMs > 21 ? 1.5 : 1;
        const floor = (b ? b.stats.ms * 1.4 : 0) * load;
        // 세계 고정: 크기·거리까지 수렴하기 전에는 촘촘히 관측해 바로잡는다. 수렴한 뒤에만 느슨하게.
        if (this.world) return Math.max(floor, this.world.converged ? 120 : 40);
        // 검출은 무겁다. 워커에서는 화면을 막지 않으니 조금 더 자주 해도 된다.
        if (this.state !== 'tracking') return Math.max(floor, inWorker ? 60 : 120);
        const gyro = this.useGyro && this.orientation.available;
        // 빠르게 움직이는 중이거나 방금 다시 잡았으면 촘촘히, 가만히 있으면 느슨하게.
        const busy = (gyro && this.orientation.rateDegPerSec > 10) || performance.now() - this.lastLostAt < 1500 || this.filter.lastShift > 0.006;
        if (inWorker) return Math.max(floor, (busy || !gyro ? 28 : 45) * load);
        return Math.max(floor, (busy || !gyro ? 40 : 66) * load);
      },
      predict: (tag, outP, outQ) => this.predictAt(tag, outP, outQ),
      // 방금까지 보고 있었다면 무거운 검출 없이 예측 자세에서 바로 다시 잡는다.
      canResume: () => this.world !== null || performance.now() - this.lastMeasAt < 500,
      onMeasurement: (m) => this.onMeasurement(m),
    });
    try {
      await this.bridge.init();
    } catch (e) {
      throw new CameraError('target', `포스터 인식 데이터(poster.mind)를 불러오지 못했어요. ${(e as Error).message}`);
    }

    this.layout();
    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('pointerup', this.onPointer);

    this.running = true;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number }) => void) => number };
    if (!opts.noFrameClock && typeof v.requestVideoFrameCallback === 'function') {
      this.vfc = v.requestVideoFrameCallback.bind(v);
      this.vfc(this.onVideoFrame);
    }
    this.bridge.start();
    this.last = performance.now();
    this.setState('searching');
    this.raf = requestAnimationFrame(this.frame);
  }

  private applyProjection(): void {
    projectionFromIntrinsics(this.K, this.vw, this.vh, this.camera.near, this.camera.far, this.camera.projectionMatrix);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  /**
   * 화면에 지금 보이는 영상 프레임이 찍힌 시각.
   * 브라우저가 프레임별 촬영 시각을 알려 주면(requestVideoFrameCallback 의 captureTime) 그 값을 쓴다 —
   * 지연값을 추측할 필요가 없어 센서와 정확히 맞는다. 없으면 "지금 − 추정 지연".
   */
  private displayTime(now: number): number {
    return this.captureValid ? this.displayCapture : now - this.latency;
  }

  /** 영상의 새 프레임이 화면에 올라올 때마다 불린다. */
  private readonly onVideoFrame = (now: number, meta: { captureTime?: number }) => {
    if (!this.running) return;
    if (this.lastVideoFrameAt) this.cameraFps += (1000 / Math.max(1, now - this.lastVideoFrameAt) - this.cameraFps) * 0.1;
    this.lastVideoFrameAt = now;
    const cap = meta.captureTime;
    // 촬영 시각이 말이 되는 범위(0~300ms 전)일 때만 믿는다.
    if (typeof cap === 'number' && Number.isFinite(cap) && now - cap > 0 && now - cap < 300) {
      this.displayCapture = cap;
      this.captureValid = true;
      this.captureLag += (now - cap - this.captureLag) * 0.1;
    } else this.captureValid = false;
    const w = this.frameWaiter;
    if (w) {
      this.frameWaiter = null;
      w(this.makeFrame(performance.now()));
    }
    this.vfc!(this.onVideoFrame);
  };

  private makeFrame(time: number): FrameSource {
    const tag: FrameTag = { time };
    if (this.captureValid) tag.sensorTime = this.displayCapture;
    if (this.world && this.sim) {
      tag.camPos = new THREE.Vector3();
      tag.camQuat = new THREE.Quaternion();
      this.sim.poseAt(tag.sensorTime ?? time - this.latency, tag.camPos, tag.camQuat);
    }
    return { element: this.video, tag };
  }

  /** 추적기에 줄 다음 프레임. 가능하면 영상의 새 프레임이 올라오는 순간에 맞춰 집는다. */
  private nextFrame(): Promise<FrameSource> | FrameSource {
    if (!this.vfc) return this.makeFrame(performance.now());
    return new Promise<FrameSource>((resolve) => {
      this.frameWaiter = resolve;
      window.setTimeout(() => {
        if (this.frameWaiter === resolve) {
          this.frameWaiter = null;
          resolve(this.makeFrame(performance.now()));
        }
      }, 200);
    });
  }

  /** 그 프레임에서 포스터가 있을 자세를 예측한다 → 추적기가 거기서부터 찾는다. */
  private predictAt(tag: FrameTag, outP: THREE.Vector3, outQ: THREE.Quaternion): boolean {
    if (tag.time - this.lastMeasAt > 600) return false; // 오래된 추정으로는 예측하지 않는다 (재검출에 맡긴다)
    if (this.world && tag.camPos && tag.camQuat) {
      if (!this.world.locked) return false;
      const e = this.world.estimate;
      const inv = this.tq.copy(tag.camQuat).invert();
      outQ.copy(inv).multiply(e.quaternion);
      outP.copy(e.position).sub(tag.camPos).applyQuaternion(inv).multiplyScalar(1 / e.width);
      return true;
    }
    if (this.filter.count < 3) return false;
    const has = this.useGyro && this.orientation.at(tag.sensorTime ?? tag.time - this.latency, this.qwc);
    if (!has) return false; // 센서가 없으면 예측할 근거가 없다 → 직전 자세에서 찾는다
    return this.filter.predict(this.qwc, outP, outQ, tag.sensorTime ?? tag.time - this.latency);
  }

  private onMeasurement(m: Measurement): void {
    const now = m.tag.time;
    this.streak = now - this.lastMeasAt < 250 ? this.streak + 1 : 1;
    this.lastMeasAt = now;

    if (this.world && m.tag.camPos && m.tag.camQuat) {
      this.world.add(m.tag.camPos, m.tag.camQuat, m.p, m.q, now);
      return;
    }
    // 프레임이 찍힌 시각을 브라우저가 알려 주면 그대로 쓰고, 아니면 지연값을 추정해서 맞춘다.
    const st = m.tag.sensorTime ?? now - this.latency;
    if (this.useGyro && this.autoLatency && m.tag.sensorTime === undefined) this.tuneLatency(m, now);
    const has = this.useGyro && this.orientation.at(st, this.qwc);
    if (has && this.orientation.rateDegPerSec > TRACKING.maxRateDegPerSec) return;
    this.filter.update(m.p, m.q, has ? this.qwc : this.ID, has, st);

    // 초점거리 자동 보정: 비스듬한 시점이 충분히 모이면 다시 계산한다.
    const cal = this.calibrator;
    if (cal && m.rms < 3 && cal.offer(m.corr, m.pose) && cal.ready && now - this.lastCalibAt > 1200) {
      this.lastCalibAt = now;
      const f = cal.estimate();
      if (f && Math.abs(f / this.K.fx - 1) > 0.012) {
        this.K = { ...this.K, fx: f, fy: f };
        this.bridge?.setIntrinsics(this.K);
        this.applyProjection();
        this.calibratedCount++;
        saveFocal(this.vw, this.vh, f);
      }
    }
  }

  /**
   * 카메라 영상이 방향 센서보다 얼마나 늦는지 스스로 맞춘다.
   * 폰이 돌고 있을 때, 지연값이 맞으면 "세계 기준 포스터 방향"이 변하지 않는다. 틀리면 도는 방향으로 출렁인다.
   * 후보 지연값마다 그 출렁임을 누적해서 가장 작은 값을 고른다.
   */
  private tuneLatency(m: Measurement, now: number): void {
    const rate = this.orientation.rateDegPerSec;
    if (rate < 12 || rate > TRACKING.maxRateDegPerSec || this.filter.count < 8) {
      this.latPrev.length = 0;
      return;
    }
    for (let i = 0; i < LAT_CANDIDATES.length; i++) {
      if (!this.orientation.at(now - LAT_CANDIDATES[i], this.tq)) return;
      const qwp = this.tq.multiply(m.q); // 이 지연값을 가정했을 때의 세계 기준 포스터 방향
      const prev = this.latPrev[i];
      if (prev) this.latCost[i] += (prev.angleTo(qwp) * 180) / Math.PI;
      (this.latPrev[i] ??= new THREE.Quaternion()).copy(qwp);
    }
    if (++this.latSamples % 45 === 0) {
      let best = 0;
      for (let i = 1; i < LAT_CANDIDATES.length; i++) if (this.latCost[i] < this.latCost[best]) best = i;
      // 포물선 보간으로 후보 사이의 값을 얻는다.
      let lat = LAT_CANDIDATES[best];
      if (best > 0 && best < LAT_CANDIDATES.length - 1) {
        const a = this.latCost[best - 1];
        const b = this.latCost[best];
        const c = this.latCost[best + 1];
        const den = a - 2 * b + c;
        if (den > 1e-9) lat += (0.5 * (a - c) * (LAT_CANDIDATES[1] - LAT_CANDIDATES[0])) / den;
      }
      this.latency += (lat - this.latency) * 0.5;
      for (let i = 0; i < this.latCost.length; i++) this.latCost[i] *= 0.6; // 오래된 정보는 서서히 잊는다
    }
  }

  /** 영상과 캔버스를 화면을 꽉 채우도록(cover) 같은 사각형으로 놓는다. */
  private layout(): void {
    if (!this.renderer) return;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const vr = this.vw / this.vh;
    let w = cw;
    let h = cw / vr;
    if (h < ch) {
      h = ch;
      w = ch * vr;
    }
    const left = (cw - w) / 2;
    const top = (ch - h) / 2;
    for (const el of [this.video, this.renderer.domElement]) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }
    const cap = RATIO_STEPS[Math.max(this.ratioStep, this.stage.quality === 'low' ? 2 : 0)];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(w, h, false);
  }

  private readonly onPointer = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.cb.onTap(this.state === 'tracking' ? this.stage.pick(this.ndc, this.camera) : null);
  };

  private readonly frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    this.updatePose(performance.now(), dt);
    this.stage.update(dt, this.camera, this.renderer.domElement.height);
    this.renderer.render(this.scene, this.camera);

    // 프레임이 밀리면 그리는 해상도를 한 단계씩 낮춘다.
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    this.totalFrames++;
    if (dt * 1000 > 25) this.slowFrames++;
    // 시작 직후의 셰이더 컴파일·등장 연출 때문에 생기는 일시적인 끊김은 세지 않는다.
    const settled = this.state === 'tracking' && performance.now() - this.trackingSince > 6000;
    this.slowFor = settled && this.frameMs > 21 ? this.slowFor + dt : 0;
    if (this.slowFor > 1.5 && this.ratioStep < RATIO_STEPS.length - 1) {
      this.ratioStep++;
      this.slowFor = 0;
      this.layout();
    }
  };

  private updatePose(now: number, dt: number): void {
    const root = this.stage.root;
    const fresh = now - this.lastMeasAt < TRACKING.graceMs;
    let ok = false;

    if (this.world && this.sim) {
      // 세계 모드: 카메라가 세계 안에서 움직이고, 포스터는 추정한 세계 자세에 고정돼 있다.
      this.sim.poseAt(this.displayTime(now), this.camera.position, this.camera.quaternion);
      const pose = this.world.pose(dt);
      if (pose && this.world.locked) {
        root.position.copy(pose.position);
        root.quaternion.copy(pose.quaternion);
        root.scale.setScalar(pose.width);
        ok = true; // 한번 고정되면 포스터가 화면 밖으로 나가도 유지된다
      }
    } else if (this.filter.count >= 3 && (fresh || this.state === 'tracking')) {
      const dtm = this.displayTime(now);
      const has = this.useGyro && this.orientation.at(dtm, this.qwc);
      if (this.filter.predict(has ? this.qwc : this.ID, this.tp, this.tq, dtm)) {
        root.position.copy(this.tp);
        root.quaternion.copy(this.tq);
        root.scale.setScalar(1);
        ok = fresh;
      }
    }

    if (ok) {
      if (this.state !== 'tracking' && (this.world || this.streak >= 3)) {
        root.visible = true;
        this.stage.setTracking(true);
        if (!this.stage.isRevealed) this.stage.reveal();
        this.trackingSince = now;
        this.lastLostAt = now;
        this.setState('tracking');
      }
    } else if (this.state === 'tracking') {
      root.visible = false;
      this.filter.reset();
      this.lastLostAt = now;
      this.stage.setTracking(false);
      this.setState('lost');
    }
  }

  /**
   * 개발용(모의 카메라): 지금 그린 덮개의 네 꼭짓점과, lagMs 전 프레임의 참값 사이 차이 (영상 픽셀, [dx,dy]×4).
   */
  devCornerError(lagMs: number): number[] | null {
    const sim = this.sim;
    if (!sim || !this.stage.root.visible) return null;
    const truthCam = this.devCam;
    truthCam.fov = sim.camera.fov;
    truthCam.aspect = sim.camera.aspect;
    truthCam.near = sim.camera.near;
    truthCam.far = sim.camera.far;
    truthCam.updateProjectionMatrix();
    if (!sim.poseAt(performance.now() - lagMs, truthCam.position, truthCam.quaternion)) return null;
    truthCam.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this.stage.root.updateMatrixWorld(true);
    const out: number[] = [];
    const hw = (POSTER.widthM / 2) * sim.posterScaleValue;
    const hh = (POSTER.heightM / 2) * sim.posterScaleValue;
    const A = POSTER.heightM / POSTER.widthM;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const t = this.tp.set(sx * hw, sy * hh, 0).project(truthCam);
      const tx = t.x;
      const ty = t.y;
      const o = this.tp.set(sx * 0.5, (sy * A) / 2, 0).applyMatrix4(this.stage.root.matrixWorld).project(this.camera);
      out.push(((o.x - tx) * this.vw) / 2, ((o.y - ty) * this.vh) / 2);
    }
    return out;
  }
  private readonly devCam = new THREE.PerspectiveCamera();

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.bridge?.stop();
    this.bridge = null;
    this.orientation.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.sim?.stop();
    this.sim = null;
    if (this.renderer) {
      this.renderer.domElement.removeEventListener('pointerup', this.onPointer);
      this.scene.remove(this.stage.root);
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.video?.remove();
  }
}

const focalKey = (w: number, h: number) => `rabbit.focal.${w}x${h}`;
function loadFocal(w: number, h: number): number | null {
  try {
    const v = Number(localStorage.getItem(focalKey(w, h)));
    // 터무니없는 저장값은 버린다 (긴 변 시야각 35°~100° 범위만)
    const fov = (2 * Math.atan(Math.max(w, h) / 2 / v) * 180) / Math.PI;
    return Number.isFinite(v) && fov > 35 && fov < 100 ? v : null;
  } catch {
    return null;
  }
}
function saveFocal(w: number, h: number, f: number): void {
  try {
    localStorage.setItem(focalKey(w, h), String(Math.round(f * 10) / 10));
  } catch {
    /* 저장 못 해도 동작에는 지장 없다 */
  }
}
