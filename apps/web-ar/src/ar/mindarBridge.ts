/**
 * MindAR 를 "특징점 찾기·따라가기"에만 쓰고, 자세 계산은 우리 쪽(pose/planarPose.ts)에서 하도록 끼워 넣는다.
 *
 * 바꾼 것 (벤더 파일은 그대로 두고 인스턴스 메서드만 덮어쓴다)
 *  1. 카메라 내부 파라미터: MindAR 의 "세로 시야각 45°" 가정을 실제 값(또는 보정값)으로 바꾼다.
 *  2. 추적 해상도: 포스터 폭 128px 그림 대신 256px 그림을 쓴다 → 한 픽셀이 포스터 위 4.6mm → 2.3mm.
 *  3. 탐색 시작점: 직전 자세 대신 "자이로로 예측한 지금 자세"에서 찾는다 → 폰을 빨리 돌려도 덜 놓친다.
 *  4. 자세 풀이: 워커의 ICP 대신 재투영 오차 최소화 + 이상점 제거.
 *
 * 내놓는 것: 프레임마다 포스터의 카메라 기준 자세 (three.js 카메라 좌표, 단위 = 포스터 가로 폭).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { Compiler, Controller } from '../vendor/mindar/mindar-image.prod.js';
import { type Corr, type Intrinsics, type Pose, solvePlanarPose } from './pose/planarPose';
import { H, TARGETS } from './sceneLayout';

export interface FrameTag {
  /** 이 프레임을 집어 온 시각 (performance.now, ms) */
  time: number;
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

export interface BridgeOptions {
  width: number;
  height: number;
  intrinsics: Intrinsics;
  targetUrl: string;
  /** 지금 입력에 올라와 있는 프레임의 꼬리표를 돌려준다 (MindAR 가 프레임을 읽는 순간 호출된다). */
  grab(): FrameTag;
  /** 그 프레임에서 포스터가 있을 것으로 예상되는 자세. 모르면 null. */
  predict?(tag: FrameTag, outP: Vector3, outQ: Quaternion): boolean;
  onMeasurement(m: Measurement): void;
  /** true: 256px 추적 그림 사용 (정밀) / false: MindAR 기본 128px */
  fineTracking?: boolean;
}

type Mvt = number[][];

interface TargetMap {
  /** 포스터 폭 1 이 타깃 픽셀로 몇 픽셀인가 */
  k: number;
  /** 포스터 중심의 타깃 픽셀 좌표 */
  bx: number;
  by: number;
}

const MIN_POINTS = 8;

export class MindarBridge {
  private controller!: Controller;
  private K: Intrinsics;
  private maps: TargetMap[] = [];
  private matchingDataList: unknown[] = [];
  private tag: FrameTag = { time: 0 };
  private readonly m4 = new Matrix4();
  private readonly tp = new Vector3();
  private readonly tq = new Quaternion();
  /** 진단용 */
  stats = { trackHz: 0, points: 0, inliers: 0, rms: 0, target: -1, rejects: 0 };
  private lastTrackAt = 0;

  constructor(private readonly opts: BridgeOptions) {
    this.K = { ...opts.intrinsics };
  }

  get intrinsics(): Intrinsics {
    return this.K;
  }

  async init(): Promise<void> {
    const o = this.opts;
    this.controller = new Controller({ inputWidth: o.width, inputHeight: o.height, maxTrack: 1, warmupTolerance: 0, missTolerance: 0, onUpdate: () => {} });
    const c = this.controller as unknown as Record<string, any>;
    this.writeIntrinsics();

    const res = await fetch(o.targetUrl);
    if (!res.ok) throw new Error(`target ${res.status}`);
    let buffer = await res.arrayBuffer();
    if (o.fineTracking !== false) {
      // .mind 안의 추적 그림 두 단계(256px, 128px)의 순서를 바꿔, MindAR 가 정밀한 쪽을 쓰게 한다.
      const comp = new Compiler() as unknown as { importData(b: ArrayBuffer): Array<{ trackingData: unknown[] }>; exportData(): ArrayBuffer | Uint8Array };
      const list = comp.importData(buffer);
      for (const d of list) if (Array.isArray(d.trackingData) && d.trackingData.length >= 2) d.trackingData = [d.trackingData[1], d.trackingData[0]];
      const out = comp.exportData();
      buffer = out instanceof ArrayBuffer ? out : (out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
    }
    const added = (this.controller as unknown as { addImageTargetsFromBuffer(b: ArrayBuffer): { dimensions: Array<[number, number]>; matchingDataList: unknown[] } }).addImageTargetsFromBuffer(buffer);
    if (added.dimensions.length !== TARGETS.length) throw new Error(`poster.mind 의 타깃 수(${added.dimensions.length})가 sceneLayout.TARGETS(${TARGETS.length})와 다릅니다`);
    this.matchingDataList = added.matchingDataList;
    this.maps = added.dimensions.map(([w, h], i) => {
      const crop = TARGETS[i].crop;
      const cw = crop.u1 - crop.u0;
      const ch = crop.v1 - crop.v0;
      return { k: w / cw, bx: ((0.5 - crop.u0) / cw) * w, by: ((0.5 - crop.v0) / ch) * h };
    });

    // 프레임을 읽는 순간의 꼬리표를 붙잡는다.
    const loader = c.inputLoader;
    const origLoad = loader.loadInput.bind(loader);
    loader.loadInput = (input: unknown) => {
      this.tag = o.grab();
      return origLoad(input);
    };

    // 추적 + 자세 풀이를 우리 것으로 바꾼다.
    const maxRms = 6 * (Math.max(o.width, o.height) / 1280);
    const pp = new Vector3();
    const pq = new Quaternion();
    c._trackAndUpdate = async (inputT: unknown, lastMvt: Mvt, targetIndex: number): Promise<Mvt | null> => {
      const tag = this.tag;
      let init = mvtToPose(lastMvt);
      let usedPrediction = false;
      if (o.predict && o.predict(tag, pp, pq)) {
        init = this.posterToMarker(pp, pq, targetIndex);
        usedPrediction = true;
      }
      let r = c.tracker.track(inputT, poseToMvt(init), targetIndex) as { worldCoords: Array<{ x: number; y: number }>; screenCoords: Array<{ x: number; y: number }> };
      if (r.worldCoords.length < MIN_POINTS && usedPrediction) {
        init = mvtToPose(lastMvt);
        r = c.tracker.track(inputT, lastMvt, targetIndex);
      }
      this.stats.points = r.worldCoords.length;
      if (r.worldCoords.length < MIN_POINTS) {
        this.stats.rejects++;
        return null;
      }
      const corr: Corr[] = r.worldCoords.map((w, i) => ({ X: w.x, Y: w.y, u: r.screenCoords[i].x, v: r.screenCoords[i].y }));
      const sol = solvePlanarPose(corr, this.K, init, { minInliers: MIN_POINTS, maxRms });
      if (!sol) {
        this.stats.rejects++;
        return null;
      }
      const now = performance.now();
      if (this.lastTrackAt) this.stats.trackHz += (1000 / Math.max(1, now - this.lastTrackAt) - this.stats.trackHz) * 0.1;
      this.lastTrackAt = now;
      this.stats.inliers = sol.inliers;
      this.stats.rms = sol.rms;
      this.stats.target = targetIndex;

      const m: Measurement = { targetIndex, tag, p: new Vector3(), q: new Quaternion(), rms: sol.rms, inliers: sol.inliers, total: sol.total, corr, pose: sol.pose };
      this.markerToPoster(sol.pose, targetIndex, m.p, m.q);
      o.onMeasurement(m);
      return poseToMvt(sol.pose);
    };
  }

  /** 내부 파라미터를 MindAR 의 추적기와 워커에 반영한다. 실행 중에 바꿔도 된다(초점거리 보정). */
  setIntrinsics(K: Intrinsics): void {
    this.K = { ...K };
    this.writeIntrinsics();
    const c = this.controller as unknown as Record<string, any>;
    if (this.matchingDataList.length) {
      c.worker.postMessage({ type: 'setup', inputWidth: this.opts.width, inputHeight: this.opts.height, projectionTransform: c.projectionTransform, debugMode: false, matchingDataList: this.matchingDataList });
    }
  }

  private writeIntrinsics(): void {
    const pt = (this.controller as unknown as { projectionTransform: number[][] }).projectionTransform;
    // 추적기가 같은 배열 객체를 참조하므로 제자리에서 고친다.
    pt[0][0] = this.K.fx;
    pt[0][1] = 0;
    pt[0][2] = this.K.cx;
    pt[1][0] = 0;
    pt[1][1] = this.K.fy;
    pt[1][2] = this.K.cy;
  }

  start(input: HTMLVideoElement | HTMLCanvasElement): void {
    this.controller.dummyRun(input);
    this.controller.processVideo(input);
  }

  stop(): void {
    try {
      this.controller?.stopProcessVideo();
      this.controller?.dispose();
    } catch {
      /* 이미 정리됨 */
    }
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

  /** 포스터 좌표계의 자세를 임시 변수 없이 쓰기 위한 도우미 */
  scratch(): { p: Vector3; q: Quaternion } {
    return { p: this.tp, q: this.tq };
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

export { H as POSTER_ASPECT };
