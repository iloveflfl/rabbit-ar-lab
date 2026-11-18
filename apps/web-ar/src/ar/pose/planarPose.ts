/**
 * 평면 타깃의 자세 추정 (PnP).
 *
 * MindAR 는 특징점을 찾고 따라가는 데만 쓰고, 자세는 여기서 직접 푼다:
 *   - 카메라 내부 파라미터(초점거리)를 실제 값으로 쓸 수 있다 (MindAR 는 세로 시야각 45° 고정 가정).
 *   - 이상점을 걸러 내고(Huber + MAD), 재투영 오차를 직접 최소화한다.
 *
 * 좌표 규약 (OpenCV 와 같음)
 *   평면 좌표 (X, Y, 0), 카메라 좌표 x → 오른쪽, y → 아래, z → 앞.
 *   x_cam = R · X + t,   u = fx · x/z + cx,   v = fy · y/z + cy
 */

export interface Corr {
  X: number;
  Y: number;
  u: number;
  v: number;
}
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}
export interface Pose {
  /** 3×3 회전, 행 우선 */
  R: number[];
  t: [number, number, number];
}
export interface PoseResult {
  pose: Pose;
  /** 인라이어의 재투영 오차 RMS (픽셀) */
  rms: number;
  inliers: number;
  total: number;
}

/* ───────── 작은 선형대수 ───────── */

/** n×n 연립방정식 (부분 피벗 가우스 소거). 특이하면 null. A 와 b 를 덮어쓴다. */
export function solveLinear(A: number[], b: number[], n: number): number[] | null {
  for (let c = 0; c < n; c++) {
    let p = c;
    let best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(A[r * n + c]);
      if (v > best) {
        best = v;
        p = r;
      }
    }
    if (best < 1e-14) return null;
    if (p !== c) {
      for (let k = c; k < n; k++) {
        const tmp = A[c * n + k];
        A[c * n + k] = A[p * n + k];
        A[p * n + k] = tmp;
      }
      const tb = b[c];
      b[c] = b[p];
      b[p] = tb;
    }
    const inv = 1 / A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] * inv;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

const det3 = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

function inv3(m: number[]): number[] | null {
  const d = det3(m);
  if (Math.abs(d) < 1e-18) return null;
  const k = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * k,
    (m[2] * m[7] - m[1] * m[8]) * k,
    (m[1] * m[5] - m[2] * m[4]) * k,
    (m[5] * m[6] - m[3] * m[8]) * k,
    (m[0] * m[8] - m[2] * m[6]) * k,
    (m[2] * m[3] - m[0] * m[5]) * k,
    (m[3] * m[7] - m[4] * m[6]) * k,
    (m[1] * m[6] - m[0] * m[7]) * k,
    (m[0] * m[4] - m[1] * m[3]) * k,
  ];
}

const mul3 = (a: number[], b: number[]): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};

/** 가장 가까운 회전행렬 (극분해를 뉴턴 반복으로). */
export function orthonormalize(R: number[]): number[] {
  let m = R.slice();
  for (let i = 0; i < 8; i++) {
    const inv = inv3(m);
    if (!inv) break;
    // m ← (m + m⁻ᵀ) / 2
    m = [
      (m[0] + inv[0]) / 2, (m[1] + inv[3]) / 2, (m[2] + inv[6]) / 2,
      (m[3] + inv[1]) / 2, (m[4] + inv[4]) / 2, (m[5] + inv[7]) / 2,
      (m[6] + inv[2]) / 2, (m[7] + inv[5]) / 2, (m[8] + inv[8]) / 2,
    ];
  }
  return m;
}

/** 회전벡터 ω → 회전행렬 (로드리게스). */
export function expSO3(wx: number, wy: number, wz: number): number[] {
  const th = Math.hypot(wx, wy, wz);
  if (th < 1e-12) return [1, -wz, wy, wz, 1, -wx, -wy, wx, 1];
  const x = wx / th;
  const y = wy / th;
  const z = wz / th;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}

/* ───────── 호모그래피 ───────── */

/** 평면 좌표 → 픽셀의 호모그래피 (정규화 DLT). 행 우선 3×3, h33 = 1. */
export function estimateHomography(c: Corr[]): number[] | null {
  const n = c.length;
  if (n < 4) return null;
  let mx = 0;
  let my = 0;
  let mu = 0;
  let mv = 0;
  for (const p of c) {
    mx += p.X;
    my += p.Y;
    mu += p.u;
    mv += p.v;
  }
  mx /= n;
  my /= n;
  mu /= n;
  mv /= n;
  let dx = 0;
  let du = 0;
  for (const p of c) {
    dx += Math.hypot(p.X - mx, p.Y - my);
    du += Math.hypot(p.u - mu, p.v - mv);
  }
  if (dx < 1e-12 || du < 1e-12) return null;
  const sx = (Math.SQRT2 * n) / dx;
  const su = (Math.SQRT2 * n) / du;

  const A = new Array<number>(64).fill(0);
  const b = new Array<number>(8).fill(0);
  const row = new Array<number>(8);
  const acc = (r: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (r[i] === 0) continue;
      b[i] += r[i] * rhs;
      for (let j = i; j < 8; j++) A[i * 8 + j] += r[i] * r[j];
    }
  };
  for (const p of c) {
    const X = (p.X - mx) * sx;
    const Y = (p.Y - my) * sx;
    const u = (p.u - mu) * su;
    const v = (p.v - mv) * su;
    row[0] = X; row[1] = Y; row[2] = 1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = -u * X; row[7] = -u * Y;
    acc(row, u);
    row[0] = 0; row[1] = 0; row[2] = 0; row[3] = X; row[4] = Y; row[5] = 1; row[6] = -v * X; row[7] = -v * Y;
    acc(row, v);
  }
  for (let i = 0; i < 8; i++) for (let j = 0; j < i; j++) A[i * 8 + j] = A[j * 8 + i];
  const h = solveLinear(A, b, 8);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // H = Tu⁻¹ · Hn · Tx
  const Tx = [sx, 0, -mx * sx, 0, sx, -my * sx, 0, 0, 1];
  const TuInv = [1 / su, 0, mu, 0, 1 / su, mv, 0, 0, 1];
  const H = mul3(mul3(TuInv, Hn), Tx);
  if (Math.abs(H[8]) < 1e-14) return null;
  for (let i = 0; i < 9; i++) H[i] /= H[8];
  return H;
}

/** 호모그래피를 내부 파라미터로 분해해 자세 초기값을 얻는다. */
export function poseFromHomography(H: number[], K: Intrinsics): Pose | null {
  const a = [
    (H[0] - K.cx * H[6]) / K.fx, (H[1] - K.cx * H[7]) / K.fx, (H[2] - K.cx * H[8]) / K.fx,
    (H[3] - K.cy * H[6]) / K.fy, (H[4] - K.cy * H[7]) / K.fy, (H[5] - K.cy * H[8]) / K.fy,
    H[6], H[7], H[8],
  ];
  const n1 = Math.hypot(a[0], a[3], a[6]);
  const n2 = Math.hypot(a[1], a[4], a[7]);
  if (n1 < 1e-12 || n2 < 1e-12) return null;
  let l = 2 / (n1 + n2);
  if (a[8] * l < 0) l = -l; // 타깃은 카메라 앞에 있어야 한다
  const r1 = [a[0] * l, a[3] * l, a[6] * l];
  const r2 = [a[1] * l, a[4] * l, a[7] * l];
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const R = orthonormalize([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
  return { R, t: [a[2] * l, a[5] * l, a[8] * l] };
}

/* ───────── 재투영 오차 최소화 ───────── */

export function residuals(c: Corr[], K: Intrinsics, p: Pose, out: Float64Array): void {
  const R = p.R;
  for (let i = 0; i < c.length; i++) {
    const X = c[i].X;
    const Y = c[i].Y;
    const x = R[0] * X + R[1] * Y + p.t[0];
    const y = R[3] * X + R[4] * Y + p.t[1];
    const z = R[6] * X + R[7] * Y + p.t[2];
    if (z < 1e-9) {
      out[i * 2] = 1e4;
      out[i * 2 + 1] = 1e4;
      continue;
    }
    out[i * 2] = (K.fx * x) / z + K.cx - c[i].u;
    out[i * 2 + 1] = (K.fy * y) / z + K.cy - c[i].v;
  }
}

/**
 * 가우스–뉴턴(LM 감쇠)으로 자세를 다듬는다. weights 가 있으면 점별 가중(0 = 제외).
 * 반환: 가중 평균 제곱 오차.
 */
export function refinePose(c: Corr[], K: Intrinsics, pose: Pose, iters = 8, huberPx = 3, weights?: Float64Array): number {
  const n = c.length;
  const res = new Float64Array(n * 2);
  const JtJ = new Array<number>(36);
  const Jtr = new Array<number>(6);
  const ju = new Array<number>(6);
  const jv = new Array<number>(6);
  let mu = 1e-4;
  const cost = (p: Pose): number => {
    residuals(c, K, p, res);
    let s = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const w0 = weights ? weights[i] : 1;
      if (w0 === 0) continue;
      const e = Math.hypot(res[i * 2], res[i * 2 + 1]);
      s += w0 * (e <= huberPx ? e * e : huberPx * (2 * e - huberPx));
      wsum += w0;
    }
    return wsum > 0 ? s / wsum : Infinity;
  };
  let cur = cost(pose);
  for (let it = 0; it < iters; it++) {
    JtJ.fill(0);
    Jtr.fill(0);
    residuals(c, K, pose, res);
    const R = pose.R;
    for (let i = 0; i < n; i++) {
      const w0 = weights ? weights[i] : 1;
      if (w0 === 0) continue;
      const X = c[i].X;
      const Y = c[i].Y;
      const xr = R[0] * X + R[1] * Y;
      const yr = R[3] * X + R[4] * Y;
      const zr = R[6] * X + R[7] * Y;
      const x = xr + pose.t[0];
      const y = yr + pose.t[1];
      const z = zr + pose.t[2];
      if (z < 1e-9) continue;
      const iz = 1 / z;
      const a = K.fx * iz;
      const b = -K.fx * x * iz * iz;
      const d = K.fy * iz;
      const e = -K.fy * y * iz * iz;
      // dXc/dω = [[0, zr, -yr], [-zr, 0, xr], [yr, -xr, 0]],  dXc/dt = I
      ju[0] = b * yr; ju[1] = a * zr - b * xr; ju[2] = -a * yr; ju[3] = a; ju[4] = 0; ju[5] = b;
      jv[0] = -d * zr + e * yr; jv[1] = -e * xr; jv[2] = d * xr; jv[3] = 0; jv[4] = d; jv[5] = e;
      const ru = res[i * 2];
      const rv = res[i * 2 + 1];
      const en = Math.hypot(ru, rv);
      const w = w0 * (en <= huberPx ? 1 : huberPx / en);
      for (let p = 0; p < 6; p++) {
        Jtr[p] += w * (ju[p] * ru + jv[p] * rv);
        for (let q = p; q < 6; q++) JtJ[p * 6 + q] += w * (ju[p] * ju[q] + jv[p] * jv[q]);
      }
    }
    for (let p = 0; p < 6; p++) for (let q = 0; q < p; q++) JtJ[p * 6 + q] = JtJ[q * 6 + p];

    let improved = false;
    for (let tries = 0; tries < 5 && !improved; tries++) {
      const A = JtJ.slice();
      for (let p = 0; p < 6; p++) A[p * 6 + p] *= 1 + mu;
      const d = solveLinear(A, Jtr.map((v) => -v), 6);
      if (!d) {
        mu *= 10;
        continue;
      }
      const cand: Pose = { R: orthonormalize(mul3(expSO3(d[0], d[1], d[2]), pose.R)), t: [pose.t[0] + d[3], pose.t[1] + d[4], pose.t[2] + d[5]] };
      const cc = cost(cand);
      if (cc < cur) {
        pose.R = cand.R;
        pose.t = cand.t;
        const gain = cur - cc;
        cur = cc;
        mu = Math.max(1e-7, mu * 0.3);
        improved = true;
        if (gain < 1e-7) return cur;
      } else mu *= 10;
    }
    if (!improved) break;
  }
  return cur;
}

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

/**
 * 대응점에서 자세를 푼다.
 *   1) 초기값(주어지면 그것, 아니면 호모그래피 분해)에서 견고하게 다듬고
 *   2) 잔차의 중앙값 기준으로 이상점을 빼고 다시 다듬는다.
 */
export function solvePlanarPose(c: Corr[], K: Intrinsics, init?: Pose | null, opts: { minInliers?: number; maxRms?: number } = {}): PoseResult | null {
  const n = c.length;
  const minInliers = opts.minInliers ?? 6;
  if (n < Math.max(4, minInliers)) return null;
  const tryFrom = (start: Pose | null): PoseResult | null => {
    if (!start) return null;
    const pose: Pose = { R: start.R.slice(), t: [start.t[0], start.t[1], start.t[2]] };
    refinePose(c, K, pose, 6, 4);
    const res = new Float64Array(n * 2);
    residuals(c, K, pose, res);
    const err = new Array<number>(n);
    for (let i = 0; i < n; i++) err[i] = Math.hypot(res[i * 2], res[i * 2 + 1]);
    const med = median(err);
    const thresh = Math.max(2.5, med * 3);
    const w = new Float64Array(n);
    let inl = 0;
    for (let i = 0; i < n; i++) if (err[i] <= thresh) {
      w[i] = 1;
      inl++;
    }
    if (inl < minInliers) return null;
    refinePose(c, K, pose, 6, 3, w);
    residuals(c, K, pose, res);
    let s = 0;
    for (let i = 0; i < n; i++) if (w[i]) s += res[i * 2] * res[i * 2] + res[i * 2 + 1] * res[i * 2 + 1];
    if (pose.t[2] <= 0) return null;
    return { pose, rms: Math.sqrt(s / inl), inliers: inl, total: n };
  };
  const maxRms = opts.maxRms ?? Infinity;
  let r = tryFrom(init ?? null);
  if (!r || r.rms > maxRms) {
    const H = estimateHomography(c);
    const r2 = tryFrom(H ? poseFromHomography(H, K) : null);
    if (r2 && (!r || r2.rms < r.rms)) r = r2;
  }
  return r && r.rms <= maxRms ? r : null;
}

/** 회전을 알 때 이동만 선형 최소제곱으로 푼다 (자이로로 회전이 고정된 경우). */
export function solveTranslation(c: Corr[], K: Intrinsics, R: number[], t0?: [number, number, number]): [number, number, number] | null {
  let t: [number, number, number] | null = t0 ? [t0[0], t0[1], t0[2]] : null;
  for (let pass = 0; pass < 3; pass++) {
    const A = new Array<number>(9).fill(0);
    const b = new Array<number>(3).fill(0);
    for (const p of c) {
      const xr = R[0] * p.X + R[1] * p.Y;
      const yr = R[3] * p.X + R[4] * p.Y;
      const zr = R[6] * p.X + R[7] * p.Y;
      const du = p.u - K.cx;
      const dv = p.v - K.cy;
      let w = 1;
      if (t) {
        const z = zr + t[2];
        if (z > 1e-9) {
          const e = Math.hypot((K.fx * (xr + t[0])) / z - du, (K.fy * (yr + t[1])) / z - dv);
          w = e <= 3 ? 1 : 3 / e;
          w /= z * z; // 대수 오차를 픽셀 오차에 가깝게
        }
      }
      // fx·tx − du·tz = du·zr − fx·xr ;  fy·ty − dv·tz = dv·zr − fy·yr
      const r1 = [K.fx, 0, -du];
      const r2 = [0, K.fy, -dv];
      const h1 = du * zr - K.fx * xr;
      const h2 = dv * zr - K.fy * yr;
      for (let i = 0; i < 3; i++) {
        b[i] += w * (r1[i] * h1 + r2[i] * h2);
        for (let j = 0; j < 3; j++) A[i * 3 + j] += w * (r1[i] * r1[j] + r2[i] * r2[j]);
      }
    }
    const x = solveLinear(A, b, 3);
    if (!x) return t;
    t = [x[0], x[1], x[2]];
  }
  return t && t[2] > 0 ? t : null;
}

/** 평면 법선과 시선 사이의 각 (도). 0 = 정면. */
export function tiltDeg(p: Pose): number {
  const nrm = [p.R[2], p.R[5], p.R[8]];
  const tl = Math.hypot(p.t[0], p.t[1], p.t[2]) || 1;
  const d = Math.abs((nrm[0] * p.t[0] + nrm[1] * p.t[1] + nrm[2] * p.t[2]) / tl);
  return (Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

/** 평면 좌표계에서 본 카메라 방향 (단위 벡터). 다양한 시점인지 판단하는 데 쓴다. */
export function viewDirection(p: Pose): [number, number, number] {
  const R = p.R;
  const x = -(R[0] * p.t[0] + R[3] * p.t[1] + R[6] * p.t[2]);
  const y = -(R[1] * p.t[0] + R[4] * p.t[1] + R[7] * p.t[2]);
  const z = -(R[2] * p.t[0] + R[5] * p.t[1] + R[8] * p.t[2]);
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
