import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FocalCalibrator, GyroPoseFilter, WorldPosterEstimator } from '../src/ar/pose/filters';
import { type Corr, type Intrinsics, type Pose, estimateHomography, expSO3, orthonormalize, poseFromHomography, solvePlanarPose, solveTranslation, tiltDeg } from '../src/ar/pose/planarPose';

/** 재현 가능한 난수 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

const W = 1011;
const H = 1431; // 타깃 픽셀 (A1 비율)
const K: Intrinsics = { fx: 1154, fy: 1154, cx: 360, cy: 640 }; // 720×1280, 세로 시야각 58°

/** 포스터를 yaw/pitch 만큼 비스듬히, dist(타깃 픽셀 단위) 거리에서 보는 자세 */
function makePose(yawDeg: number, pitchDeg: number, dist: number, rollDeg = 0): Pose {
  const rad = Math.PI / 180;
  const R = orthonormalize(
    ((): number[] => {
      const a = expSO3(pitchDeg * rad, 0, 0);
      const b = expSO3(0, yawDeg * rad, 0);
      const c = expSO3(0, 0, rollDeg * rad);
      const mul = (p: number[], q: number[]) => {
        const o = new Array<number>(9);
        for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) o[r * 3 + k] = p[r * 3] * q[k] + p[r * 3 + 1] * q[3 + k] + p[r * 3 + 2] * q[6 + k];
        return o;
      };
      return mul(c, mul(a, b));
    })(),
  );
  // 포스터 중심이 광축 위 dist 에 오도록
  const cx = W / 2;
  const cy = H / 2;
  const t: [number, number, number] = [-(R[0] * cx + R[1] * cy), -(R[3] * cx + R[4] * cy), dist - (R[6] * cx + R[7] * cy)];
  return { R, t };
}

function project(p: Pose, Kc: Intrinsics, n: number, rand: () => number, noisePx: number, outliers = 0): Corr[] {
  const out: Corr[] = [];
  for (let i = 0; i < n; i++) {
    const X = rand() * W;
    const Y = rand() * H;
    const x = p.R[0] * X + p.R[1] * Y + p.t[0];
    const y = p.R[3] * X + p.R[4] * Y + p.t[1];
    const z = p.R[6] * X + p.R[7] * Y + p.t[2];
    let u = (Kc.fx * x) / z + Kc.cx + gauss(rand) * noisePx;
    let v = (Kc.fy * y) / z + Kc.cy + gauss(rand) * noisePx;
    if (i < outliers) {
      u += 40 + rand() * 60;
      v -= 30 + rand() * 50;
    }
    out.push({ X, Y, u, v });
  }
  return out;
}

const rotAngleDeg = (a: number[], b: number[]) => {
  // trace(Aᵀ B)
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += a[i] * b[i];
  return (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
};

describe('평면 자세 추정', () => {
  it('잡음이 없으면 호모그래피 분해만으로 정확하다', () => {
    const truth = makePose(25, -10, 2600, 3);
    const c = project(truth, K, 30, rng(1), 0);
    const pose = poseFromHomography(estimateHomography(c)!, K)!;
    expect(rotAngleDeg(pose.R, truth.R)).toBeLessThan(0.01);
    expect(Math.hypot(pose.t[0] - truth.t[0], pose.t[1] - truth.t[1], pose.t[2] - truth.t[2]) / truth.t[2]).toBeLessThan(1e-4);
  });

  it('픽셀 잡음 1.5px 에서 한 프레임의 오차는 1° / 1.2% 안 (이 잔떨림은 시간 필터가 없앤다)', () => {
    const r = rng(7);
    for (const [yaw, pitch] of [[0, 0], [30, 0], [-30, 8], [15, -20]]) {
      const truth = makePose(yaw, pitch, 2400);
      const res = solvePlanarPose(project(truth, K, 45, r, 1.5), K)!;
      expect(res).not.toBeNull();
      expect(rotAngleDeg(res.pose.R, truth.R)).toBeLessThan(1.0);
      expect(Math.abs(res.pose.t[2] - truth.t[2]) / truth.t[2]).toBeLessThan(0.012);
      expect(res.rms).toBeLessThan(3);
    }
  });

  it('이상점 20% 가 섞여도 걸러 낸다', () => {
    const truth = makePose(-20, 12, 2500);
    const res = solvePlanarPose(project(truth, K, 50, rng(3), 1, 10), K)!;
    expect(res.inliers).toBeLessThanOrEqual(42);
    expect(res.inliers).toBeGreaterThanOrEqual(36);
    expect(rotAngleDeg(res.pose.R, truth.R)).toBeLessThan(0.6);
  });

  it('이전 자세를 초기값으로 주면 그 근처에서 수렴한다', () => {
    const truth = makePose(18, 5, 2300);
    const near = makePose(15, 3, 2350);
    const res = solvePlanarPose(project(truth, K, 40, rng(5), 1), K, near)!;
    expect(rotAngleDeg(res.pose.R, truth.R)).toBeLessThan(0.5);
  });

  it('점이 너무 적거나 평면 뒤쪽 해는 거부한다', () => {
    expect(solvePlanarPose(project(makePose(0, 0, 2000), K, 3, rng(1), 0), K)).toBeNull();
  });

  it('회전을 알면 이동만 선형으로 푼다', () => {
    const truth = makePose(22, -6, 2700);
    const t = solveTranslation(project(truth, K, 40, rng(9), 1.5), K, truth.R)!;
    expect(Math.hypot(t[0] - truth.t[0], t[1] - truth.t[1]) / truth.t[2]).toBeLessThan(0.002);
    expect(Math.abs(t[2] - truth.t[2]) / truth.t[2]).toBeLessThan(0.004);
  });

  it('틀린 초점거리로 풀면 비스듬할 때 오차가 커진다 (MindAR 의 45° 가정이 문제인 이유)', () => {
    const truth = makePose(30, 0, 2400);
    const c = project(truth, K, 45, rng(11), 0.5);
    const good = solvePlanarPose(c, K)!;
    const wrongK: Intrinsics = { ...K, fx: 640 / Math.tan((22.5 * Math.PI) / 180), fy: 640 / Math.tan((22.5 * Math.PI) / 180) };
    const bad = solvePlanarPose(c, wrongK)!;
    expect(good.rms).toBeLessThan(1);
    expect(bad.rms).toBeGreaterThan(good.rms * 2);
    expect(tiltDeg(good.pose)).toBeGreaterThan(25);
  });
});

describe('초점거리 자동 보정', () => {
  it('여러 각도에서 본 프레임으로 실제 초점거리를 5% 안으로 찾는다', () => {
    const r = rng(21);
    const prior = 640 / Math.tan((32.5 * Math.PI) / 180); // 65° 가정 (실제는 58°)
    const cal = new FocalCalibrator(K.cx, K.cy, prior);
    const guess: Intrinsics = { fx: prior, fy: prior, cx: K.cx, cy: K.cy };
    for (const [yaw, pitch] of [[25, 0], [-25, 0], [12, 14], [-14, -12], [30, 8], [-30, -6], [0, 20], [18, -18]]) {
      const c = project(makePose(yaw, pitch, 2300 + r() * 500), K, 40, r, 1.5);
      const res = solvePlanarPose(c, guess)!;
      cal.offer(c, res.pose);
    }
    expect(cal.ready).toBe(true);
    const f = cal.estimate()!;
    expect(Math.abs(f - K.fx) / K.fx).toBeLessThan(0.05);
  });

  it('정면 프레임만으로는 보정하지 않는다 (정보가 없다)', () => {
    const cal = new FocalCalibrator(K.cx, K.cy, 1000);
    const r = rng(2);
    for (let i = 0; i < 10; i++) {
      const c = project(makePose(r() * 4 - 2, r() * 4 - 2, 2400), K, 40, r, 1);
      cal.offer(c, solvePlanarPose(c, K)!.pose);
    }
    expect(cal.ready).toBe(false);
    expect(cal.estimate()).toBeNull();
  });
});

describe('자이로 융합 필터', () => {
  const truthQ = new Quaternion().setFromEuler(new Euler(0.1, -0.3, 0.02));
  const truthP = new Vector3(0.1, -0.05, -2.1);

  it('폰이 떨려도(회전 잡음) 출력 방향의 떨림이 관측보다 크게 줄어든다', () => {
    const r = rng(31);
    const f = new GyroPoseFilter();
    const outP = new Vector3();
    const outQ = new Quaternion();
    let rawSum = 0;
    let filtSum = 0;
    let n = 0;
    for (let i = 0; i < 240; i++) {
      // 손떨림: 카메라가 세계에서 조금씩 돈다
      const qwc = new Quaternion().setFromEuler(new Euler(Math.sin(i * 0.31) * 0.02, Math.sin(i * 0.23) * 0.03, 0));
      const inv = qwc.clone().invert();
      const trueQ = inv.clone().multiply(truthQ);
      const trueP = truthP.clone().applyQuaternion(inv);
      // 시각 관측에는 0.4° 정도의 잡음이 있다
      const noise = new Quaternion().setFromEuler(new Euler(gauss(r) * 0.007, gauss(r) * 0.007, gauss(r) * 0.007));
      const measQ = trueQ.clone().multiply(noise);
      const measP = trueP.clone().multiplyScalar(1 + gauss(r) * 0.004);
      f.update(measP, measQ, qwc, true);
      f.predict(qwc, outP, outQ);
      if (i > 40) {
        rawSum += measQ.angleTo(trueQ) ** 2;
        filtSum += outQ.angleTo(trueQ) ** 2;
        n++;
      }
    }
    const raw = Math.sqrt(rawSum / n);
    const filt = Math.sqrt(filtSum / n);
    expect(filt).toBeLessThan(raw * 0.35);
  });

  it('폰을 빠르게 돌려도 자이로 덕분에 지연 없이 따라간다', () => {
    const f = new GyroPoseFilter();
    const outP = new Vector3();
    const outQ = new Quaternion();
    for (let i = 0; i < 30; i++) f.update(truthP, truthQ, new Quaternion(), true);
    // 관측 없이 자이로만 25° 돌았다
    const qwc = new Quaternion().setFromEuler(new Euler(0, 0.44, 0));
    f.predict(qwc, outP, outQ);
    const expectQ = qwc.clone().invert().multiply(truthQ);
    expect(outQ.angleTo(expectQ)).toBeLessThan(1e-6);
    expect(outP.distanceTo(truthP.clone().applyQuaternion(qwc.clone().invert()))).toBeLessThan(1e-6);
  });

  it('자이로가 천천히 흘러도(표류) 시각 관측이 계속 바로잡는다', () => {
    const f = new GyroPoseFilter();
    const outP = new Vector3();
    const outQ = new Quaternion();
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      const drift = new Quaternion().setFromEuler(new Euler(0, i * 0.0003, 0)); // 30fps 에서 약 0.5°/초
      f.update(truthP, truthQ, drift, true); // 실제로는 폰이 가만히 있다
      f.predict(drift, outP, outQ);
      if (i > 60) worst = Math.max(worst, outQ.angleTo(truthQ));
    }
    expect((worst * 180) / Math.PI).toBeLessThan(0.6);
  });

  it('자이로가 없으면 관측을 평활만 한다', () => {
    const f = new GyroPoseFilter();
    const outP = new Vector3();
    const outQ = new Quaternion();
    const id = new Quaternion();
    for (let i = 0; i < 20; i++) f.update(truthP, truthQ, id, false);
    f.predict(id, outP, outQ);
    expect(outQ.angleTo(truthQ)).toBeLessThan(1e-6);
  });
});

describe('세계 고정 추정 (WebXR)', () => {
  /** 실제 폭 width 인 포스터를 여러 위치에서 본 관측을 만든다 */
  function observe(est: WorldPosterEstimator, width: number, r: () => number, steps: number, baseline: number) {
    const P = new Vector3(0.3, 1.4, -2.0);
    const Q = new Quaternion().setFromEuler(new Euler(0, 0.2, 0));
    for (let i = 0; i < steps; i++) {
      const k = i / steps;
      const cam = new Vector3(Math.sin(k * 6) * baseline, 1.5 + Math.sin(k * 9) * baseline * 0.3, Math.cos(k * 4) * baseline * 0.5);
      const look = new Quaternion().setFromEuler(new Euler(Math.sin(k * 5) * 0.08, Math.sin(k * 7) * 0.12, 0));
      const inv = look.clone().invert();
      // 카메라 기준 포스터 자세: 위치는 포스터 폭 단위
      const p = P.clone().sub(cam).applyQuaternion(inv).multiplyScalar(1 / width);
      p.multiplyScalar(1 + gauss(r) * 0.006); // 깊이 잡음
      p.x += gauss(r) * 0.003;
      p.y += gauss(r) * 0.003;
      const q = inv.clone().multiply(Q).multiply(new Quaternion().setFromEuler(new Euler(gauss(r) * 0.006, gauss(r) * 0.006, gauss(r) * 0.006)));
      est.add(cam, look, p, q, i * 33);
    }
    return { P, Q };
  }

  it('A1 포스터: 위치 2cm, 방향 0.5° 안으로 수렴한다', () => {
    const est = new WorldPosterEstimator();
    const { P, Q } = observe(est, 0.594, rng(41), 120, 0.25);
    expect(est.locked).toBe(true);
    expect(est.estimate.position.distanceTo(P)).toBeLessThan(0.02);
    expect((est.estimate.quaternion.angleTo(Q) * 180) / Math.PI).toBeLessThan(0.5);
    expect(Math.abs(est.estimate.width - 0.594)).toBeLessThan(0.02);
  });

  it('다른 크기로 인쇄했거나 모니터에 띄운 포스터도 시차로 실제 크기를 알아낸다', () => {
    const est = new WorldPosterEstimator();
    const { P } = observe(est, 0.3, rng(43), 160, 0.3);
    expect(Math.abs(est.estimate.width - 0.3)).toBeLessThan(0.03);
    expect(est.estimate.position.distanceTo(P)).toBeLessThan(0.05);
  });

  it('카메라가 거의 안 움직이면 A1 크기를 그대로 믿는다', () => {
    const est = new WorldPosterEstimator();
    observe(est, 0.594, rng(47), 40, 0.004);
    expect(Math.abs(est.estimate.width - 0.594)).toBeLessThan(0.03);
  });

  it('잘못된 관측 몇 개는 무시한다', () => {
    const est = new WorldPosterEstimator();
    const { P } = observe(est, 0.594, rng(53), 80, 0.2);
    for (let i = 0; i < 5; i++) est.add(new Vector3(0, 1.5, 0), new Quaternion(), new Vector3(1.5, 0.4, -1.2), new Quaternion().setFromEuler(new Euler(0.6, 0.9, 0)), 3000 + i * 33);
    expect(est.estimate.position.distanceTo(P)).toBeLessThan(0.03);
  });

  it('출력은 추정값으로 부드럽게 다가간다', () => {
    const est = new WorldPosterEstimator();
    observe(est, 0.594, rng(59), 60, 0.2);
    const pose = est.pose(1 / 60)!;
    for (let i = 0; i < 120; i++) est.pose(1 / 60);
    expect(pose.position.distanceTo(est.estimate.position)).toBeLessThan(1e-3);
  });
});
