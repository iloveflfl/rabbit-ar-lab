/**
 * AR 보기: 카메라 영상에서 실물 포스터를 찾아(MindAR 이미지 추적) 스테이지를 그 위에 얹는다.
 *
 * - 추적 대상은 포스터 그림 자체다(QR 이 아니다).
 * - 타깃 3개(전체/위/아래) 중 잡힌 것 하나의 자세를 포스터 전체 좌표계로 바꿔 쓴다.
 * - 추적을 놓치면 잠깐(GRACE_MS) 마지막 자세를 유지하다가 숨기고, 놓쳤다고 화면에 알린다.
 *   놓친 상태를 숨기거나 억지로 고정해 두지 않는다.
 */
import * as THREE from 'three';
import type { HighlightId } from '@rabbit/shared';
import type { LabStage } from '../stage/stage';
import { TARGETS, targetToPoster } from './sceneLayout';
import { SimCamera } from './simCamera';

export type TrackState = 'starting' | 'searching' | 'tracking' | 'lost';

export interface ArCallbacks {
  onState(state: TrackState): void;
  onTap(panel: HighlightId | null): void;
}

export const TRACKING = {
  targetUrl: 'assets/targets/poster.mind',
  /** MindAR OneEuro 필터. 실기기에서 떨림/지연을 보고 조정한다 (docs/AR_CALIBRATION.md). */
  filterMinCF: 0.001,
  filterBeta: 1000,
  warmupTolerance: 3,
  missTolerance: 8,
  /** 앵커 자세 추가 평활 (1/초). 클수록 빠르게 따라간다. */
  followRate: 26,
  /** 추적을 놓친 뒤 마지막 자세를 유지하는 시간 */
  graceMs: 380,
} as const;

export class CameraError extends Error {
  constructor(readonly kind: 'denied' | 'unavailable' | 'insecure' | 'target' | 'unknown', message: string) {
    super(message);
  }
}

export class ArView {
  private video!: HTMLVideoElement;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 10, 100000);
  private controller: import('../vendor/mindar/mindar-image.prod.js').Controller | null = null;
  private stream: MediaStream | null = null;
  private sim: SimCamera | null = null;
  private raf = 0;
  private running = false;
  private last = 0;
  private state: TrackState = 'starting';

  /** 타깃별: 앵커(타깃 폭 = 1) → 포스터 좌표 변환까지 곱해 둔 행렬 */
  private post: THREE.Matrix4[] = [];
  private latest: Array<number[] | null> = [];
  private active = -1;
  private lostAt = 0;
  private hasPose = false;
  private readonly targetM = new THREE.Matrix4();
  private readonly tPos = new THREE.Vector3();
  private readonly tQuat = new THREE.Quaternion();
  private readonly tScale = new THREE.Vector3();
  private frameMs = 16;
  private slowFor = 0;
  private downgraded = false;
  private readonly ndc = new THREE.Vector2();
  private readonly onResize = () => this.layout();

  constructor(private readonly container: HTMLElement, private readonly stage: LabStage, private readonly cb: ArCallbacks) {}

  get simulated(): boolean {
    return this.sim !== null;
  }
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
  get activeTarget(): string | null {
    return this.active >= 0 ? TARGETS[this.active].id : null;
  }

  private setState(s: TrackState): void {
    if (s === this.state) return;
    this.state = s;
    this.cb.onState(s);
  }

  async start(opts: { simulate?: boolean } = {}): Promise<void> {
    this.cb.onState('starting');
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
    } else {
      if (!window.isSecureContext) throw new CameraError('insecure', '카메라는 HTTPS 주소에서만 쓸 수 있어요.');
      if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unavailable', '이 브라우저에서는 카메라를 쓸 수 없어요.');
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', '카메라 권한이 거부됐어요.');
        if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('unavailable', '쓸 수 있는 카메라를 찾지 못했어요.');
        throw new CameraError('unknown', '카메라를 켜지 못했어요.');
      }
    }
    this.video.srcObject = this.stream;
    await new Promise<void>((res, rej) => {
      this.video.onloadedmetadata = () => res();
      this.video.onerror = () => rej(new CameraError('unknown', '카메라 영상을 받지 못했어요.'));
    });
    await this.video.play().catch(() => {});
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    // MindAR 는 입력의 width/height 속성을 읽는다.
    this.video.width = vw;
    this.video.height = vh;

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: this.stage.quality === 'high', powerPreference: 'high-performance', preserveDrawingBuffer: import.meta.env.DEV });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'ar-canvas';
    this.container.appendChild(this.renderer.domElement);
    // MindAR 의 가상 카메라: 세로 시야각 45°, 영상과 같은 종횡비. 캔버스를 영상과 똑같이 겹쳐 놓으므로 투영이 정확히 맞는다.
    this.camera.aspect = vw / vh;
    this.camera.updateProjectionMatrix();
    this.scene.add(this.camera);

    await this.stage.init(this.renderer);
    this.stage.root.visible = false;
    this.scene.add(this.stage.root);

    const { Controller } = await import('../vendor/mindar/mindar-image.prod.js');
    this.controller = new Controller({
      inputWidth: vw,
      inputHeight: vh,
      maxTrack: 1,
      filterMinCF: TRACKING.filterMinCF,
      filterBeta: TRACKING.filterBeta,
      warmupTolerance: TRACKING.warmupTolerance,
      missTolerance: TRACKING.missTolerance,
      onUpdate: (d) => {
        if (d.type === 'updateMatrix' && d.targetIndex !== undefined) this.latest[d.targetIndex] = d.worldMatrix ?? null;
      },
    });

    let dimensions: Array<[number, number]>;
    try {
      const res = await fetch(TRACKING.targetUrl);
      if (!res.ok) throw new Error(String(res.status));
      dimensions = this.controller.addImageTargetsFromBuffer(await res.arrayBuffer()).dimensions;
    } catch {
      throw new CameraError('target', '포스터 인식 데이터(poster.mind)를 불러오지 못했어요.');
    }
    if (dimensions.length !== TARGETS.length) throw new CameraError('target', `poster.mind 의 타깃 수(${dimensions.length})가 sceneLayout.TARGETS(${TARGETS.length})와 달라요. 타깃을 다시 컴파일하세요.`);

    this.post = dimensions.map(([w, h], i) => {
      // MindAR 의 postMatrix: 타깃 픽셀 좌표 → 타깃 중심 원점·폭 1
      const m = new THREE.Matrix4().compose(new THREE.Vector3(w / 2, w / 2 + (h - w) / 2, 0), new THREE.Quaternion(), new THREE.Vector3(w, w, w));
      const t = targetToPoster(TARGETS[i]);
      return m.multiply(new THREE.Matrix4().compose(new THREE.Vector3(...t.position), new THREE.Quaternion(), new THREE.Vector3(t.scale, t.scale, t.scale)));
    });
    this.latest = dimensions.map(() => null);

    this.layout();
    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('pointerup', this.onPointer);

    this.controller.dummyRun(this.video);
    this.controller.processVideo(this.video);
    this.running = true;
    this.last = performance.now();
    this.setState('searching');
    this.raf = requestAnimationFrame(this.frame);
  }

  /** 영상과 캔버스를 화면을 꽉 채우도록(cover) 같은 사각형으로 놓는다. */
  private layout(): void {
    if (!this.renderer) return;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const vr = this.video.videoWidth / this.video.videoHeight;
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
    const cap = this.downgraded || this.stage.quality === 'low' ? 1.25 : 2;
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
    this.updatePose(now, dt);
    this.stage.update(dt, this.camera, this.renderer.domElement.height);
    this.renderer.render(this.scene, this.camera);

    // 느린 기기에서는 해상도를 낮춘다.
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    if (!this.downgraded) {
      this.slowFor = this.frameMs > 36 ? this.slowFor + dt : 0;
      if (this.slowFor > 4) {
        this.downgraded = true;
        this.layout();
      }
    }
  };

  private updatePose(now: number, dt: number): void {
    // 지금 쓰던 타깃이 살아 있으면 계속 쓰고, 아니면 살아 있는 다른 타깃으로 옮긴다.
    let idx = this.active >= 0 && this.latest[this.active] ? this.active : -1;
    if (idx < 0) idx = this.latest.findIndex((m) => m !== null);
    const root = this.stage.root;

    if (idx >= 0) {
      this.targetM.fromArray(this.latest[idx]!).multiply(this.post[idx]);
      this.targetM.decompose(this.tPos, this.tQuat, this.tScale);
      const wasLost = this.state !== 'tracking';
      if (!this.hasPose || (wasLost && now - this.lostAt > TRACKING.graceMs)) {
        root.position.copy(this.tPos);
        root.quaternion.copy(this.tQuat);
        root.scale.copy(this.tScale);
      } else {
        const k = 1 - Math.exp(-TRACKING.followRate * dt);
        root.position.lerp(this.tPos, k);
        root.quaternion.slerp(this.tQuat, k);
        root.scale.lerp(this.tScale, k);
      }
      this.hasPose = true;
      this.active = idx;
      this.lostAt = 0;
      if (wasLost) {
        root.visible = true;
        this.stage.setTracking(true);
        if (!this.stage.isRevealed) this.stage.reveal();
        this.setState('tracking');
      }
    } else if (this.state === 'tracking') {
      if (this.lostAt === 0) this.lostAt = now;
      if (now - this.lostAt > TRACKING.graceMs) {
        root.visible = false;
        this.active = -1;
        this.stage.setTracking(false);
        this.setState('lost');
      }
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    try {
      this.controller?.stopProcessVideo();
      this.controller?.dispose();
    } catch {
      /* 이미 정리됨 */
    }
    this.controller = null;
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
