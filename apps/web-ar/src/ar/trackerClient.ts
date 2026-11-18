/**
 * 추적 코어를 워커에서(안 되면 메인 스레드에서) 돌리고, 프레임을 "필요한 만큼만" 먹인다.
 *
 * 왜 주기를 조절하나
 *   자세는 센서(자이로) 또는 세계 추적이 매 프레임 이어 주므로, 영상 추적은 그것을 바로잡는 역할만 하면 된다.
 *   그래서 매 화면 프레임마다 돌릴 필요가 없다 — 덜 돌릴수록 발열과 끊김이 준다.
 */
import { Quaternion, Vector3 } from 'three';
import { type CoreFrame, type CoreInit, type CoreResult, type FrameTag, type Measurement, TrackerCore } from './mindarBridge';
import type { Corr, Intrinsics } from './pose/planarPose';
import type { FromWorker, ToWorker } from './trackerWorker';

export interface FrameSource {
  /** 영상 요소 (비디오·캔버스). 워커로 보낼 때는 ImageBitmap 으로 바꾼다. */
  element?: HTMLVideoElement | HTMLCanvasElement;
  /** RGBA 픽셀, 위에서 아래로 (WebXR 카메라 영상) */
  pixels?: Uint8Array;
  tag: FrameTag;
}

export interface ClientOptions extends CoreInit {
  /** 다음에 처리할 프레임. 지금은 줄 게 없으면 null (잠시 뒤 다시 묻는다). */
  getFrame(): Promise<FrameSource | null> | FrameSource | null;
  /** 프레임 사이 최소 간격 (ms). 상태에 따라 달라진다. */
  intervalMs(): number;
  predict(tag: FrameTag, outP: Vector3, outQ: Quaternion): boolean;
  /** 예측 자세를 믿고 검출을 건너뛰어도 되는가 */
  canResume(): boolean;
  onMeasurement(m: Measurement): void;
  /** false 면 워커를 쓰지 않는다 (비교 시험용) */
  useWorker?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TrackerClient {
  mode: 'starting' | 'worker' | 'inline' = 'starting';
  /** 진단용 */
  stats = { hz: 0, ms: 0, points: 0, inliers: 0, rms: 0, target: -1, detects: 0, misses: 0 };
  private worker: Worker | null = null;
  private core: TrackerCore | null = null;
  private running = false;
  private nextId = 1;
  private lastSentAt = 0;
  private lastOkAt = 0;
  private failStreak = 0;
  private pending: { resolve: (r: { result: CoreResult; pixels?: Uint8Array } | null) => void; timer: number } | null = null;
  /** 워커가 돌려준 픽셀 버퍼 (WebXR 경로에서 다시 쓴다) */
  spare: Uint8Array | null = null;
  private readonly pp = new Vector3();
  private readonly pq = new Quaternion();

  constructor(private readonly opts: ClientOptions) {}

  async init(): Promise<void> {
    const cfg: CoreInit = { width: this.opts.width, height: this.opts.height, intrinsics: this.opts.intrinsics, targetUrl: new URL(this.opts.targetUrl, location.href).href, fineTracking: this.opts.fineTracking };
    if (this.opts.useWorker !== false && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        await this.initWorker(cfg);
        this.mode = 'worker';
        return;
      } catch (e) {
        console.warn('추적 워커를 쓸 수 없어 메인 스레드에서 돌립니다:', e);
        this.worker?.terminate();
        this.worker = null;
      }
    }
    this.core = new TrackerCore();
    await this.core.init(cfg);
    this.mode = 'inline';
  }

  private initWorker(cfg: CoreInit): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./trackerWorker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      const timer = window.setTimeout(() => reject(new Error('worker init timeout')), 25_000);
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'worker error'));
      };
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          w.onmessage = (e2: MessageEvent<FromWorker>) => this.onWorkerMessage(e2.data);
          w.onerror = () => this.settle(null);
          resolve();
        } else if (m.type === 'error') {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      this.send({ type: 'init', cfg });
    });
  }

  private send(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  private onWorkerMessage(m: FromWorker): void {
    if (m.type === 'result') this.settle({ result: m.result, pixels: m.pixels });
    else if (m.type === 'error') {
      console.warn('tracker worker:', m.message);
      this.settle(null);
    }
  }

  private settle(v: { result: CoreResult; pixels?: Uint8Array } | null): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(v);
  }

  setIntrinsics(K: Intrinsics): void {
    if (this.worker) this.send({ type: 'intrinsics', K });
    else this.core?.setIntrinsics(K);
  }

  /** 추적 상태를 버리고 다음 프레임에서 검출부터 하게 한다. */
  reset(): void {
    if (this.worker) this.send({ type: 'reset' });
    else this.core?.reset();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    while (this.running) {
      const wait = this.opts.intervalMs() - (performance.now() - this.lastSentAt);
      if (wait > 1) await sleep(wait);
      if (!this.running) break;
      let src: FrameSource | null = null;
      try {
        src = await this.opts.getFrame();
      } catch {
        src = null;
      }
      if (!src) {
        await sleep(120);
        continue;
      }
      const frame: CoreFrame = { id: this.nextId++ };
      if (this.opts.predict(src.tag, this.pp, this.pq)) {
        frame.pred = { p: [this.pp.x, this.pp.y, this.pp.z], q: [this.pq.x, this.pq.y, this.pq.z, this.pq.w] };
        // 예측만 믿고 계속 헛짚으면 가끔은 검출을 돌려 바로잡는다.
        frame.resume = this.opts.canResume() && this.failStreak % 3 !== 2;
      }
      this.lastSentAt = performance.now();
      const out = await this.run(src, frame);
      if (!this.running) break;
      if (out?.pixels) this.spare = out.pixels;
      if (!out) {
        await sleep(200);
        continue;
      }
      this.handle(out.result, src.tag);
    }
  }

  private async run(src: FrameSource, frame: CoreFrame): Promise<{ result: CoreResult; pixels?: Uint8Array } | null> {
    if (this.core) {
      try {
        const result = src.pixels ? await this.core.processPixels(src.pixels, frame) : await this.core.process(src.element!, frame);
        return { result, pixels: src.pixels };
      } catch (e) {
        console.warn('tracker:', e);
        return null;
      }
    }
    const reply = new Promise<{ result: CoreResult; pixels?: Uint8Array } | null>((resolve) => {
      this.pending = { resolve, timer: window.setTimeout(() => this.settle(null), 6000) };
    });
    if (src.pixels) {
      this.send({ type: 'frame', frame, pixels: src.pixels }, [src.pixels.buffer]);
    } else {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(src.element!);
      } catch {
        this.settle(null);
        return reply;
      }
      this.send({ type: 'frame', frame, bitmap }, [bitmap]);
    }
    return reply;
  }

  private handle(r: CoreResult, tag: FrameTag): void {
    const s = this.stats;
    s.ms += (r.ms - s.ms) * 0.2;
    s.points = r.total;
    if (r.detected) s.detects++;
    if (!r.ok || !r.p || !r.q || !r.corr || !r.R || !r.t) {
      s.misses++;
      this.failStreak++;
      return;
    }
    this.failStreak = 0;
    const now = performance.now();
    if (this.lastOkAt) s.hz += (1000 / Math.max(1, now - this.lastOkAt) - s.hz) * 0.15;
    this.lastOkAt = now;
    s.inliers = r.inliers;
    s.rms = r.rms;
    s.target = r.targetIndex;
    const n = r.corr.length / 4;
    const corr: Corr[] = new Array(n);
    for (let i = 0; i < n; i++) corr[i] = { X: r.corr[i * 4], Y: r.corr[i * 4 + 1], u: r.corr[i * 4 + 2], v: r.corr[i * 4 + 3] };
    this.opts.onMeasurement({
      targetIndex: r.targetIndex,
      tag,
      p: new Vector3().fromArray(r.p),
      q: new Quaternion().fromArray(r.q),
      rms: r.rms,
      inliers: r.inliers,
      total: r.total,
      corr,
      pose: { R: r.R, t: r.t },
    });
  }

  stop(): void {
    this.running = false;
    this.settle(null);
    if (this.worker) {
      this.send({ type: 'stop' });
      const w = this.worker;
      window.setTimeout(() => w.terminate(), 300);
      this.worker = null;
    }
    this.core?.stop();
    this.core = null;
  }
}
