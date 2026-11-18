/**
 * 시간 방향의 추정기들.
 *
 *  FocalCalibrator       초점거리(시야각)를 모를 때, 여러 각도에서 본 포스터로 스스로 보정한다.
 *  GyroPoseFilter        자이로로 회전을 "세계 기준"으로 붙들어 떨림을 없앤다 (WebXR 이 없는 기기).
 *  WorldPosterEstimator  WebXR(ARCore)가 주는 카메라의 세계 자세를 이용해, 움직이지 않는 포스터의
 *                        세계 위치·방향·실제 크기를 여러 관측에서 추정한다.
 *
 * 공통 아이디어: 포스터는 벽에 붙어 있어 움직이지 않는다. 움직이는 것은 폰뿐이다.
 * 그러니 프레임마다 흔들리는 관측을 그대로 그리지 말고, "고정된 포스터"의 자세를 추정해서 그린다.
 */
import { Quaternion, Vector3 } from 'three';
import { type Corr, type Intrinsics, estimateHomography, poseFromHomography, type Pose, refinePose, residuals, solveLinear, tiltDeg, viewDirection } from './planarPose';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const DEG = 180 / Math.PI;

/* ───────────────────────── 초점거리 자동 보정 ───────────────────────── */

interface Keyframe {
  corr: Corr[];
  dir: [number, number, number];
}

export class FocalCalibrator {
  private frames: Keyframe[] = [];
  /** 보정에 쓴 시점들의 최대 벌어짐(도). 클수록 믿을 만하다. */
  spreadDeg = 0;

  constructor(private readonly cx: number, private readonly cy: number, private readonly priorF: number) {}

  get count(): number {
    return this.frames.length;
  }

  /**
   * 비스듬히 본 프레임만 모은다(정면에서는 초점거리 정보가 없다). 이미 가진 시점과 비슷하면 버린다.
   * 반환: 새 키프레임으로 받아들였는가.
   */
  offer(corr: Corr[], pose: Pose): boolean {
    if (corr.length < 12 || tiltDeg(pose) < 9) return false;
    const dir = viewDirection(pose);
    for (const k of this.frames) {
      const dot = clamp(k.dir[0] * dir[0] + k.dir[1] * dir[1] + k.dir[2] * dir[2], -1, 1);
      if (Math.acos(dot) * DEG < 5) return false;
    }
    // 점이 많으면 고르게 덜어 낸다.
    const step = Math.max(1, Math.floor(corr.length / 48));
    this.frames.push({ corr: corr.filter((_, i) => i % step === 0).map((c) => ({ ...c })), dir });
    if (this.frames.length > 18) this.frames.shift();
    let spread = 0;
    for (let i = 0; i < this.frames.length; i++)
      for (let j = i + 1; j < this.frames.length; j++) {
        const a = this.frames[i].dir;
        const b = this.frames[j].dir;
        spread = Math.max(spread, Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) * DEG);
      }
    this.spreadDeg = spread;
    return true;
  }

  get ready(): boolean {
    return this.frames.length >= 5 && this.spreadDeg >= 14;
  }

  private cost(f: number): number {
    const K: Intrinsics = { fx: f, fy: f, cx: this.cx, cy: this.cy };
    let sum = 0;
    let n = 0;
    for (const k of this.frames) {
      const H = estimateHomography(k.corr);
      const pose = H ? poseFromHomography(H, K) : null;
      if (!pose) return Infinity;
      refinePose(k.corr, K, pose, 8, 3);
      const res = new Float64Array(k.corr.length * 2);
      residuals(k.corr, K, pose, res);
      for (let i = 0; i < k.corr.length; i++) {
        const e = Math.hypot(res[i * 2], res[i * 2 + 1]);
        sum += e <= 3 ? e * e : 3 * (2 * e - 3);
        n++;
      }
    }
    // 정보가 약할 때 엉뚱한 값으로 달아나지 않도록, 흔한 폰 카메라 값 쪽으로 약하게 당긴다.
    const prior = Math.log(f / this.priorF);
    return sum / Math.max(1, n) + 2.5 * prior * prior;
  }

  /** 모은 키프레임 전체의 재투영 오차가 가장 작은 초점거리 (황금분할 탐색). */
  estimate(): number | null {
    if (!this.ready) return null;
    let a = Math.log(this.priorF * 0.6);
    let b = Math.log(this.priorF * 1.7);
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a);
    let d = a + g * (b - a);
    let fc = this.cost(Math.exp(c));
    let fd = this.cost(Math.exp(d));
    for (let i = 0; i < 16; i++) {
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - g * (b - a);
        fc = this.cost(Math.exp(c));
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + g * (b - a);
        fd = this.cost(Math.exp(d));
      }
    }
    const f = Math.exp((a + b) / 2);
    return Number.isFinite(f) ? f : null;
  }
}

/* ───────────────────────── 자이로 융합 (카메라 기준 자세) ───────────────────────── */

/**
 * 관측: 카메라 기준 포스터 자세 (p, q)  — three.js 카메라 좌표(x 오른쪽, y 위, 보는 방향 −z), 단위는 포스터 폭.
 * 자이로: 카메라의 세계 방향 q_wc.
 *
 * 세계 기준으로 바꾸면 포스터의 방향 q_wp = q_wc · q 는 폰을 아무리 돌려도 변하지 않아야 한다.
 * 그래서 q_wp 를 천천히 평균하면 관측 잡음(떨림)이 사라지고, 그릴 때는 q = q_wc⁻¹ · q_wp 로
 * 자이로 속도(60 Hz 이상)로 즉시 따라간다. 자이로의 느린 표류는 평균이 계속 따라가며 흡수한다.
 * 위치도 같은 방식으로 "카메라에서 포스터로 가는 벡터(세계 축)" p_w 를 걸러 쓴다.
 *
 * 자이로가 없으면 q_wc = 단위 쿼터니언으로 호출한다. 그때는 적응형 평활 필터로만 동작한다.
 */
export class GyroPoseFilter {
  private readonly qwp = new Quaternion();
  private readonly pw = new Vector3();
  private readonly tq = new Quaternion();
  private readonly tv = new Vector3();
  private readonly tv2 = new Vector3();
  count = 0;
  /** 최근 관측과 추정의 차이 (진단용) */
  lastAngleDeg = 0;
  lastShift = 0;

  reset(): void {
    this.count = 0;
  }

  update(p: Vector3, q: Quaternion, qwc: Quaternion, hasGyro: boolean): void {
    const qm = this.tq.copy(qwc).multiply(q);
    const pm = this.tv.copy(p).applyQuaternion(qwc);
    if (this.count === 0) {
      this.qwp.copy(qm);
      this.pw.copy(pm);
      this.count = 1;
      return;
    }
    const ang = this.qwp.angleTo(qm) * DEG;
    const shift = this.pw.distanceTo(pm) / Math.max(1e-6, this.pw.length());
    this.lastAngleDeg = ang;
    this.lastShift = shift;

    // 위치는 "시선 방향(깊이)"과 "옆 방향"의 잡음이 전혀 다르다:
    // 옆 방향은 픽셀 단위로 정확하고, 깊이는 포스터가 조금 커 보이느냐로 추정하므로 훨씬 흔들린다.
    // 그래서 옆 방향은 빠르게 따라가고(손의 미세한 흔들림까지), 깊이는 천천히 고른다.
    const len = Math.max(1e-6, this.pw.length());
    const dir = this.tv2.copy(this.pw).multiplyScalar(1 / len);
    const delta = pm.sub(this.pw);
    const along = dir.dot(delta);
    const perp = delta.addScaledVector(dir, -along);
    const perpShift = perp.length() / len;
    const depthShift = Math.abs(along) / len;

    let ar: number;
    let aPerp: number;
    let aDepth: number;
    if (this.count < 8) {
      // 처음 몇 프레임은 단순 평균으로 빨리 수렴한다.
      ar = aPerp = aDepth = 1 / (this.count + 1);
    } else if (hasGyro) {
      // 세계 기준 방향은 변하지 않아야 한다 → 작은 차이는 잡음으로 보고 거의 무시, 큰 차이(표류·재인식)는 따라간다.
      ar = clamp(0.03 + (ang / 2.5) ** 2, 0.03, 0.6);
      aPerp = clamp(0.4 + (perpShift / 0.004) ** 2, 0.4, 1);
      aDepth = clamp(0.05 + (depthShift / 0.02) ** 2, 0.05, 0.9);
    } else {
      ar = clamp(0.12 + (ang / 1.0) ** 2, 0.12, 1);
      aPerp = clamp(0.3 + (perpShift / 0.003) ** 2, 0.3, 1);
      aDepth = clamp(0.08 + (depthShift / 0.015) ** 2, 0.08, 1);
    }
    this.qwp.slerp(qm, ar);
    this.pw.addScaledVector(perp, aPerp).addScaledVector(dir, along * aDepth);
    this.count++;
  }

  /** 지금의 카메라 방향 q_wc 에서 포스터가 보여야 할 카메라 기준 자세. */
  predict(qwc: Quaternion, outP: Vector3, outQ: Quaternion): boolean {
    if (this.count === 0) return false;
    const inv = this.tq.copy(qwc).invert();
    outQ.copy(inv).multiply(this.qwp);
    outP.copy(this.pw).applyQuaternion(inv);
    return true;
  }
}

/* ───────────────────────── 세계 고정 추정 (WebXR) ───────────────────────── */

interface Sample {
  /** 카메라의 세계 위치 (m) */
  c: Vector3;
  /** 카메라 → 포스터 중심, 세계 축, 단위는 포스터 폭 */
  d: Vector3;
  /** 포스터의 세계 방향 */
  q: Quaternion;
  /** 카메라가 보던 방향 (세계) */
  view: Vector3;
  time: number;
  w: number;
}

export interface WorldPose {
  position: Vector3;
  quaternion: Quaternion;
  /** 포스터의 실제 가로 폭 (m) */
  width: number;
}

/**
 * 관측 하나: 카메라 세계 자세(c, q_wc) + 카메라 기준 포스터 자세(p: 포스터 폭 단위, q).
 * 풀려는 것: 포스터 중심의 세계 위치 P, 세계 방향 Q, 실제 폭 s.
 *
 *   P − s · d_i = c_i      (d_i = q_wc_i · p_i)
 *
 * 한 장으로는 "가까이 있는 작은 포스터"와 "멀리 있는 큰 포스터"를 구별할 수 없지만,
 * 카메라가 조금만 움직이면(시차) s 가 정해진다. 그 전까지는 A1 폭(0.594 m)을 사전값으로 쓴다.
 * 그래서 포스터를 다른 크기로 인쇄했거나 모니터에 띄워도 깊이가 맞는다.
 */
export class WorldPosterEstimator {
  private recent: Sample[] = [];
  private keys: Sample[] = [];
  private readonly est: WorldPose = { position: new Vector3(), quaternion: new Quaternion(), width: 0.594 };
  private readonly out: WorldPose = { position: new Vector3(), quaternion: new Quaternion(), width: 0.594 };
  private has = false;
  count = 0;

  constructor(private readonly priorWidth = 0.594, private readonly priorWeight = 1) {}

  reset(): void {
    this.recent = [];
    this.keys = [];
    this.has = false;
    this.count = 0;
  }

  get locked(): boolean {
    return this.count >= 10;
  }
  get keyframes(): number {
    return this.keys.length;
  }

  add(camPos: Vector3, camQuat: Quaternion, p: Vector3, q: Quaternion, time: number, weight = 1): void {
    const s: Sample = {
      c: camPos.clone(),
      d: p.clone().applyQuaternion(camQuat),
      q: camQuat.clone().multiply(q),
      view: new Vector3(0, 0, -1).applyQuaternion(camQuat),
      time,
      w: weight,
    };
    // 이미 수렴했다면 터무니없는 관측(잘못된 정합)은 버린다.
    if (this.locked) {
      const ang = this.est.quaternion.angleTo(s.q) * DEG;
      const pos = s.c.clone().addScaledVector(s.d, this.est.width);
      if (ang > 12 || pos.distanceTo(this.est.position) > 0.35 * this.est.width + 0.05) {
        this.rejected++;
        // 계속 어긋나면 세계가 다시 잡힌 것(재위치)이므로 처음부터 다시 모은다.
        if (this.rejected > 25) this.reset();
        return;
      }
    }
    this.rejected = 0;
    this.recent.push(s);
    if (this.recent.length > 40) this.recent.shift();
    // 시점이 충분히 다른 관측은 오래 간직한다(시차 정보).
    let novel = true;
    for (const k of this.keys) {
      if (k.c.distanceTo(s.c) < 0.04 && k.view.angleTo(s.view) * DEG < 4) {
        novel = false;
        break;
      }
    }
    if (novel) {
      this.keys.push(s);
      if (this.keys.length > 70) this.keys.shift();
    }
    // 오래된 키프레임은 세계 좌표가 조금씩 흘렀을 수 있으니 내보낸다.
    if (this.keys.length > 12) this.keys = this.keys.filter((k) => time - k.time < 45_000);
    this.count++;
    this.solve();
  }

  private rejected = 0;

  private solve(): void {
    const all = this.keys.concat(this.recent.filter((r) => !this.keys.includes(r)));
    if (all.length === 0) return;

    // 방향: 쿼터니언 가중 평균 (부호를 맞춘 합). 수렴한 뒤에는 6° 넘게 벗어난 것은 뺀다.
    const ref = this.has ? this.est.quaternion : all[all.length - 1].q;
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;
    for (const s of all) {
      if (this.locked && ref.angleTo(s.q) * DEG > 6) continue;
      const sign = ref.dot(s.q) < 0 ? -1 : 1;
      x += s.q.x * sign * s.w;
      y += s.q.y * sign * s.w;
      z += s.q.z * sign * s.w;
      w += s.q.w * sign * s.w;
    }
    const len = Math.hypot(x, y, z, w);
    if (len > 1e-9) this.est.quaternion.set(x / len, y / len, z / len, w / len);

    // 위치와 크기: [P, s] 에 대한 4×4 정규방정식, Huber 재가중 2회.
    let P = this.est.position.clone();
    let sW = this.has ? this.est.width : this.priorWidth;
    for (let pass = 0; pass < 3; pass++) {
      const A = new Array<number>(16).fill(0);
      const b = new Array<number>(4).fill(0);
      for (const s of all) {
        let wt = s.w;
        if (pass > 0) {
          const r = Math.hypot(P.x - sW * s.d.x - s.c.x, P.y - sW * s.d.y - s.c.y, P.z - sW * s.d.z - s.c.z);
          const k = 0.02 + 0.03 * sW;
          if (r > k) wt *= k / r;
        }
        const d = [s.d.x, s.d.y, s.d.z];
        const c = [s.c.x, s.c.y, s.c.z];
        for (let i = 0; i < 3; i++) {
          A[i * 4 + i] += wt;
          A[i * 4 + 3] -= wt * d[i];
          A[12 + i] -= wt * d[i];
          A[15] += wt * d[i] * d[i];
          b[i] += wt * c[i];
          b[3] -= wt * d[i] * c[i];
        }
      }
      A[15] += this.priorWeight;
      b[3] += this.priorWeight * this.priorWidth;
      const sol = solveLinear(A, b, 4);
      if (!sol) break;
      P = new Vector3(sol[0], sol[1], sol[2]);
      sW = clamp(sol[3], 0.06, 3);
      if (sW !== sol[3]) {
        // 크기가 한계에 걸리면 그 크기에서 위치만 다시 평균한다.
        P.set(0, 0, 0);
        let ws = 0;
        for (const s of all) {
          P.addScaledVector(s.c, s.w).addScaledVector(s.d, sW * s.w);
          ws += s.w;
        }
        P.multiplyScalar(1 / ws);
      }
    }
    this.est.position.copy(P);
    this.est.width = sW;

    // 추정이 조금씩 고쳐질 때 화면에서 툭툭 튀지 않도록 출력만 부드럽게 따라가게 한다.
    if (!this.has) {
      this.out.position.copy(this.est.position);
      this.out.quaternion.copy(this.est.quaternion);
      this.out.width = this.est.width;
      this.has = true;
    }
  }

  /** 매 프레임 호출: 출력 자세를 추정값 쪽으로 조금씩 옮긴다. dt 는 초. */
  pose(dt: number): WorldPose | null {
    if (!this.has) return null;
    const k = 1 - Math.exp(-(this.locked ? 6 : 14) * dt);
    this.out.position.lerp(this.est.position, k);
    this.out.quaternion.slerp(this.est.quaternion, k);
    this.out.width += (this.est.width - this.out.width) * k;
    return this.out;
  }

  get estimate(): WorldPose {
    return this.est;
  }
}
