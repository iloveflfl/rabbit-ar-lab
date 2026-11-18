/**
 * 추적 코어: MindAR 를 "특징점 찾기·따라가기"에만 쓰고, 자세 계산은 우리 쪽(pose/planarPose.ts)에서 한다.
 * 이 클래스는 워커 스레드에서도, 메인 스레드에서도 돌 수 있다 (DOM 에 의존하지 않는다).
 *
 * MindAR 대비 바꾼 것 (벤더 파일은 그대로 두고 내부 메서드만 골라 쓴다)
 *  1. 카메라 내부 파라미터: "세로 시야각 45°" 가정을 실제 값(또는 보정값)으로 바꾼다.
 *  2. 추적 해상도: 포스터 폭 128px 그림 대신 256px 그림을 쓴다 → 한 픽셀이 포스터 위 4.6mm → 2.3mm.
 *  3. 탐색 시작점: 직전 자세 대신 "센서로 예측한 지금 자세"에서 찾는다 → 폰을 빨리 돌려도 덜 놓친다.
 *  4. 자세 풀이: 워커의 ICP 대신 재투영 오차 최소화 + 이상점 제거.
 *  5. 반복 주기: MindAR 의 자체 루프(매 화면 프레임)를 쓰지 않고, 프레임이 주어질 때만 한 번 처리한다.
 *  6. 재검출 생략: 포스터가 어디 있을지 알고 있으면 무거운 검출을 건너뛰고 바로 추적을 시작한다.
 *
 * 내놓는 것: 포스터의 카메라 기준 자세 (three.js 카메라 좌표, 단위 = 포스터 가로 폭).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { Compiler, Controller } from '../vendor/mindar/mindar-image.prod.js';
import { type Corr, type Intrinsics, type Pose, solvePlanarPose } from './pose/planarPose';
import { H, TARGETS } from './sceneLayout';

export interface FrameTag {
  /** 이 프레임을 집어 온 시각 (performance.now, ms) */
  time: number;
  /** 이 프레임이 실제로 찍힌 시각. 방향 센서·세계 자세를 이 시각의 값으로 맞춘다. */
  sensorTime?: number;
  /** 세계 추적이 있을 때: 그 프레임을 찍은 카메라의 세계 자세 */
  camPos?: Vector3;
  camQuat?: Quaternion;
}

export interface Measurement {
  targetIndex: number;
  tag: FrameTag;
  /** 포스터 중심의 카메라 기준 위치 (포스터 폭 단위) */
  p: Vector3;
  /** 포스터의 카메라 기준 방향 */
  q: Quaternion;
  rms: number;
  inliers: number;
  total: number;
  /** 타깃 픽셀 좌표계의 대응점과 자세 (초점거리 보정에 쓴다) */
  corr: Corr[];
  pose: Pose;
}

export interface CoreInit {
  width: number;
  height: number;
  intrinsics: Intrinsics;
  /** 절대 주소 (워커에서는 상대 주소의 기준이 다르다) */
  targetUrl: string;
  /** true: 256px 추적 그림 사용 (정밀) / false: MindAR 기본 128px */
  fineTracking?: boolean;
}

export interface CoreFrame {
  id: number;
  /** 이 프레임에서 포스터가 있을 것으로 예상되는 자세 (포스터 좌표계) */
  pred?: { p: [number, number, number]; q: [number, number, number, number] };
  /** 예상 자세를 믿고 검출 없이 바로 추적을 시작해도 되는가 */
  resume?: boolean;
}

export interface CoreResult {
  id: number;
  ok: boolean;
  targetIndex: number;
  p?: [number, number, number];
  q?: [number, number, number, number];
  rms: number;
  inliers: number;
  total: number;
  R?: number[];
  t?: [number, number, number];
  /** [X, Y, u, v] × n */
  corr?: Float32Array;
  /** 이 프레임을 처리하는 데 걸린 시간 */
  ms: number;
  /** 이번에 무거운 검출을 돌렸는가 */
  detected: boolean;
}

type Mvt = number[][];
type ImageInput = { width: number; height: number };

interface TargetMap {
  /** 포스터 폭 1 이 타깃 픽셀로 몇 픽셀인가 */
  k: number;
  /** 포스터 중심의 타깃 픽셀 좌표 */
  bx: number;
  by: number;
}

const MIN_POINTS = 8;

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class TrackerCore {
  private controller!: Controller;
  private c!: Record<string, any>;
  private K!: Intrinsics;
  private cfg!: CoreInit;
  private maps: TargetMap[] = [];
  private matchingDataList: unknown[] = [];
  private canvas!: HTMLCanvasElement | OffscreenCanvas;
  private ctx!: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** 지금 따라가고 있는 타깃 (-1 = 없음) 과 그 자세 */
  private target = -1;
  private mvt: Mvt | null = null;
  private maxRms = 6;
  private readonly m4 = new Matrix4();
  private readonly pp = new Vector3();
  private readonly pq = new Quaternion();
  private readonly op = new Vector3();
  private readonly oq = new Quaternion();

  async init(cfg: CoreInit): Promise<void> {
    this.cfg = cfg;
    this.K = { ...cfg.intrinsics };
    this.maxRms = 6 * (Math.max(cfg.width, cfg.height) / 1280);
    this.controller = new Controller({ inputWidth: cfg.width, inputHeight: cfg.height, maxTrack: 1, onUpdate: () => {} });
    this.c = this.controller as unknown as Record<string, any>;
    this.writeIntrinsics();

    const res = await fetch(cfg.targetUrl);
    if (!res.ok) throw new Error(`target ${res.status}`);
    let buffer = await res.arrayBuffer();
    if (cfg.fineTracking !== false) {
      // .mind 안의 추적 그림 두 단계(256px, 128px)의 순서를 바꿔, MindAR 가 정밀한 쪽을 쓰게 한다.
      const comp = new Compiler() as unknown as { importData(b: ArrayBuffer): Array<{ trackingData: unknown[] }>; exportData(): ArrayBuffer | Uint8Array };
      const list = comp.importData(buffer);
      for (const d of list) if (Array.isArray(d.trackingData) && d.trackingData.length >= 2) d.trackingData = [d.trackingData[1], d.trackingData[0]];
      const out = comp.exportData();
      buffer = out instanceof ArrayBuffer ? out : (out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
    }
    const added = this.c.addImageTargetsFromBuffer(buffer) as { dimensions: Array<[number, number]>; matchingDataList: unknown[] };
    if (added.dimensions.length !== TARGETS.length) throw new Error(`poster.mind 의 타깃 수(${added.dimensions.length})가 sceneLayout.TARGETS(${TARGETS.length})와 다릅니다`);
    this.matchingDataList = added.matchingDataList;
    this.maps = added.dimensions.map(([w, h], i) => {
      const crop = TARGETS[i].crop;
      const cw = crop.u1 - crop.u0;
      const ch = crop.v1 - crop.v0;
      return { k: w / cw, bx: ((0.5 - crop.u0) / cw) * w, by: ((0.5 - crop.v0) / ch) * h };
    });

    this.canvas = makeCanvas(cfg.width, cfg.height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D;
    // 셰이더를 미리 컴파일해 둔다 (첫 프레임이 몇 초씩 멈추지 않게).
    this.controller.dummyRun(this.canvas as HTMLCanvasElement);
  }

  /** 내부 파라미터를 MindAR 의 추적기와 워커에 반영한다. 실행 중에 바꿔도 된다(초점거리 보정). */
  setIntrinsics(K: Intrinsics): void {
    this.K = { ...K };
    this.writeIntrinsics();
    if (this.matchingDataList.length) {
      this.c.worker.postMessage({ type: 'setup', inputWidth: this.cfg.width, inputHeight: this.cfg.height, projectionTransform: this.c.projectionTransform, debugMode: false, matchingDataList: this.matchingDataList });
    }
  }

  private writeIntrinsics(): void {
    const pt = this.c.projectionTransform as number[][];
    // 추적기가 같은 배열 객체를 참조하므로 제자리에서 고친다.
    pt[0][0] = this.K.fx;
    pt[0][1] = 0;
    pt[0][2] = this.K.cx;
    pt[1][0] = 0;
    pt[1][1] = this.K.fy;
    pt[1][2] = this.K.cy;
  }

  /** RGBA 픽셀(위에서 아래로)을 받아 한 프레임 처리한다. */
  processPixels(pixels: Uint8Array, frame: CoreFrame): Promise<CoreResult> {
    const { width, height } = this.cfg;
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, width * height * 4), width, height), 0, 0);
    return this.process(this.canvas, frame);
  }

  /** 영상 프레임(비디오·비트맵·캔버스) 하나를 처리한다: (필요하면 검출) → 추적 → 자세 풀이. */
  async process(input: ImageInput, frame: CoreFrame): Promise<CoreResult> {
    const t0 = performance.now();
    const c = this.c;
    const out: CoreResult = { id: frame.id, ok: false, targetIndex: -1, rms: 0, inliers: 0, total: 0, ms: 0, detected: false };
    const inputT = c.inputLoader.loadInput(input);
    try {
      const pred = frame.pred ? { p: this.pp.fromArray(frame.pred.p), q: this.pq.fromArray(frame.pred.q) } : null;

      // 포스터가 어디 있을지 알고 있으면 무거운 검출을 건너뛴다.
      let resumedNow = false;
      if (this.target < 0 && pred && frame.resume) {
        resumedNow = true;
        this.target = this.chooseTarget(pred.p, pred.q);
        this.mvt = poseToMvt(this.posterToMarker(pred.p, pred.q, this.target));
      }
      if (this.target < 0) {
        out.detected = true;
        const m = (await c._detectAndMatch(inputT, TARGETS.map((_, i) => i))) as { targetIndex: number; modelViewTransform: Mvt | null };
        if (m.targetIndex !== -1 && m.modelViewTransform) {
          this.target = m.targetIndex;
          this.mvt = m.modelViewTransform;
        }
      }
      if (this.target >= 0 && this.mvt) {
        const idx = this.target;
        let init = mvtToPose(this.mvt);
        let usedPred = false;
        if (pred) {
          init = this.posterToMarker(pred.p, pred.q, idx);
          usedPred = true;
        }
        let r = c.tracker.track(inputT, poseToMvt(init), idx) as { worldCoords: Array<{ x: number; y: number }>; screenCoords: Array<{ x: number; y: number }> };
        // 예측 자세에서 못 찾았으면 직전에 실제로 본 자세에서 한 번 더 찾는다 (센서가 모르는 이동이 컸던 경우).
        if (r.worldCoords.length < MIN_POINTS && usedPred && !resumedNow) {
          init = mvtToPose(this.mvt);
          r = c.tracker.track(inputT, this.mvt, idx);
        }
        out.total = r.worldCoords.length;
        const n = r.worldCoords.length;
        const corr: Corr[] = new Array(n);
        for (let i = 0; i < n; i++) corr[i] = { X: r.worldCoords[i].x, Y: r.worldCoords[i].y, u: r.screenCoords[i].x, v: r.screenCoords[i].y };
        const sol = n >= MIN_POINTS ? solvePlanarPose(corr, this.K, init, { minInliers: MIN_POINTS, maxRms: this.maxRms }) : null;
        if (!sol) {
          this.target = -1;
          this.mvt = null;
        } else {
          this.mvt = poseToMvt(sol.pose);
          this.markerToPoster(sol.pose, idx, this.op, this.oq);
          out.ok = true;
          out.targetIndex = idx;
          out.p = [this.op.x, this.op.y, this.op.z];
          out.q = [this.oq.x, this.oq.y, this.oq.z, this.oq.w];
          out.rms = sol.rms;
          out.inliers = sol.inliers;
          out.R = sol.pose.R;
          out.t = sol.pose.t;
          const flat = new Float32Array(n * 4);
          for (let i = 0; i < n; i++) {
            flat[i * 4] = corr[i].X;
            flat[i * 4 + 1] = corr[i].Y;
            flat[i * 4 + 2] = corr[i].u;
            flat[i * 4 + 3] = corr[i].v;
          }
          out.corr = flat;
        }
      }
    } finally {
      inputT.dispose();
    }
    out.ms = performance.now() - t0;
    return out;
  }

  /** 추적 상태를 버린다 (다음 프레임은 검출부터 한다). */
  reset(): void {
    this.target = -1;
    this.mvt = null;
  }

  /** 예상 자세에서 어느 타깃(전체/위/아래)이 화면에 잘 들어오는지 고른다. */
  private chooseTarget(p: Vector3, q: Quaternion): number {
    const { width, height } = this.cfg;
    const e = this.m4.makeRotationFromQuaternion(q).elements;
    const inView = (ly: number): boolean => {
      // 포스터 좌표 (0, ly, 0) 을 카메라로
      const x = e[4] * ly + p.x;
      const y = e[5] * ly + p.y;
      const z = e[6] * ly + p.z;
      if (z > -1e-6) return false;
      const u = this.K.cx + (this.K.fx * x) / -z;
      const v = this.K.cy - (this.K.fy * y) / -z;
      return u > 0 && u < width && v > 0 && v < height;
    };
    const top = inView(H * 0.42);
    const bottom = inView(-H * 0.42);
    if (top && bottom) return 0;
    if (top) return 1;
    if (bottom) return 2;
    return inView(H * 0.2) ? 1 : inView(-H * 0.2) ? 2 : 0;
  }

  /**
   * 타깃 픽셀 좌표계(OpenCV 카메라)의 자세 → 포스터 좌표계(three.js 카메라)의 자세.
   * 타깃 좌표 X_m = k · D · X_l + b,  D = diag(1, −1, −1)  (y 아래 / z 벽 안쪽  ↔  y 위 / z 관람객 쪽)
   */
  markerToPoster(pose: Pose, targetIndex: number, outP: Vector3, outQ: Quaternion): void {
    const R = pose.R;
    const { k, bx, by } = this.maps[targetIndex];
    // R_cl = D R D
    this.m4.set(R[0], -R[1], -R[2], 0, -R[3], R[4], R[5], 0, -R[6], R[7], R[8], 0, 0, 0, 0, 1);
    outQ.setFromRotationMatrix(this.m4);
    const x = R[0] * bx + R[1] * by + pose.t[0];
    const y = R[3] * bx + R[4] * by + pose.t[1];
    const z = R[6] * bx + R[7] * by + pose.t[2];
    outP.set(x / k, -y / k, -z / k);
  }

  posterToMarker(p: Vector3, q: Quaternion, targetIndex: number): Pose {
    const { k, bx, by } = this.maps[targetIndex];
    const e = this.m4.makeRotationFromQuaternion(q).elements; // 열 우선
    // R = D R_cl D
    const R = [e[0], -e[4], -e[8], -e[1], e[5], e[9], -e[2], e[6], e[10]];
    const dx = k * p.x;
    const dy = -k * p.y;
    const dz = -k * p.z;
    return { R, t: [dx - (R[0] * bx + R[1] * by), dy - (R[3] * bx + R[4] * by), dz - (R[6] * bx + R[7] * by)] };
  }

  stop(): void {
    try {
      this.controller?.dispose();
    } catch {
      /* 이미 정리됨 */
    }
  }
}

function mvtToPose(m: Mvt): Pose {
  return { R: [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]], t: [m[0][3], m[1][3], m[2][3]] };
}
function poseToMvt(p: Pose): Mvt {
  const R = p.R;
  return [
    [R[0], R[1], R[2], p.t[0]],
    [R[3], R[4], R[5], p.t[1]],
    [R[6], R[7], R[8], p.t[2]],
  ];
}

/** 영상 픽셀 좌표의 내부 파라미터로 three.js 투영 행렬을 만든다 (캔버스가 영상과 정확히 겹쳐 있을 때). */
export function projectionFromIntrinsics(K: Intrinsics, width: number, height: number, near: number, far: number, out: Matrix4): Matrix4 {
  // prettier-ignore
  out.set(
    (2 * K.fx) / width, 0, 1 - (2 * K.cx) / width, 0,
    0, (2 * K.fy) / height, (2 * K.cy) / height - 1, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0,
  );
  return out;
}

/** 흔한 폰 뒤쪽 카메라의 영상 시야각(긴 변 기준)으로 잡은 초기 초점거리. 이후 자동 보정이 고친다. */
export function priorIntrinsics(width: number, height: number, longSideFovDeg = 65): Intrinsics {
  const f = Math.max(width, height) / 2 / Math.tan((longSideFovDeg * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2 };
}
