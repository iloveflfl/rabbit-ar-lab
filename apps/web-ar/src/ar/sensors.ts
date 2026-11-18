/**
 * 폰의 방향 센서(자이로 융합 결과)를 카메라의 세계 방향 q_wc 로 바꿔서, 시각별로 꺼내 쓸 수 있게 보관한다.
 *
 * 가속도계를 두 번 적분해서 위치를 구하는 방식은 쓰지 않는다 — 몇 초 만에 수십 cm 씩 흘러서 쓸 수 없다.
 * 위치는 카메라 영상(시각)에서, 회전은 자이로에서 얻어 서로 보완한다.
 * (위치까지 센서로 붙들려면 ARCore 같은 시각-관성 추적이 필요하고, 그건 WebXR 경로가 맡는다.)
 */
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';

export interface OrientationSource {
  /** 주어진 시각(performance.now 기준 ms)의 카메라 세계 방향. 센서가 없으면 null. */
  at(time: number, out: Quaternion): boolean;
  readonly available: boolean;
  /** 최근 각속도 (도/초). 빠르게 돌 때 관측을 덜 믿는 데 쓴다. */
  readonly rateDegPerSec: number;
  stop(): void;
}

interface Stamp {
  t: number;
  q: Quaternion;
}

/** 시각별 방향 이력 (원형 버퍼 + 보간) */
export class OrientationHistory {
  private readonly buf: Stamp[] = [];
  rateDegPerSec = 0;

  push(t: number, q: Quaternion): void {
    const last = this.buf[this.buf.length - 1];
    if (last) {
      const dt = (t - last.t) / 1000;
      if (dt <= 0) return;
      const inst = (last.q.angleTo(q) * 180) / Math.PI / dt;
      this.rateDegPerSec += (inst - this.rateDegPerSec) * 0.3;
    }
    this.buf.push({ t, q: q.clone() });
    if (this.buf.length > 240) this.buf.shift();
  }

  get latestTime(): number {
    return this.buf.length ? this.buf[this.buf.length - 1].t : -Infinity;
  }

  at(time: number, out: Quaternion): boolean {
    const b = this.buf;
    const n = b.length;
    if (n === 0) return false;
    if (time >= b[n - 1].t) {
      out.copy(b[n - 1].q);
      return true;
    }
    for (let i = n - 2; i >= 0; i--) {
      if (b[i].t <= time) {
        const span = b[i + 1].t - b[i].t;
        out.copy(b[i].q).slerp(b[i + 1].q, span > 0 ? (time - b[i].t) / span : 0);
        return true;
      }
    }
    out.copy(b[0].q);
    return true;
  }
}

const Z = new Vector3(0, 0, 1);
const Q_CAMERA = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // 기기 좌표 → 뒤쪽 카메라가 −z 를 보는 좌표

/**
 * deviceorientation 이벤트 기반.
 * iOS 는 사용자 동작(탭) 안에서 권한을 먼저 받아야 한다 → requestPermission() 을 "AR 시작" 버튼 핸들러에서 부른다.
 * Android Chrome 의 deviceorientation 은 자기 센서를 쓰지 않는 상대 방향이라 실내에서도 안정적이다.
 */
export class DeviceOrientationSource implements OrientationSource {
  private readonly history = new OrientationHistory();
  private readonly euler = new Euler();
  private readonly q = new Quaternion();
  private readonly q0 = new Quaternion();
  private started = false;

  static async requestPermission(): Promise<boolean> {
    const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (!D) return false;
    if (typeof D.requestPermission === 'function') {
      try {
        return (await D.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
    return true;
  }

  private readonly onEvent = (e: DeviceOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const orient = MathUtils.degToRad((screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number);
    // W3C 기기 방향(Z-X'-Y'') → three.js (YXZ), 그다음 카메라 좌표와 화면 회전을 반영한다.
    this.euler.set(MathUtils.degToRad(e.beta), MathUtils.degToRad(e.alpha), -MathUtils.degToRad(e.gamma), 'YXZ');
    this.q.setFromEuler(this.euler).multiply(Q_CAMERA).multiply(this.q0.setFromAxisAngle(Z, -orient));
    this.history.push(performance.now(), this.q);
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('deviceorientation', this.onEvent, true);
  }

  get available(): boolean {
    return performance.now() - this.history.latestTime < 500;
  }
  get rateDegPerSec(): number {
    return this.history.rateDegPerSec;
  }

  at(time: number, out: Quaternion): boolean {
    return this.available && this.history.at(time, out);
  }

  stop(): void {
    window.removeEventListener('deviceorientation', this.onEvent, true);
    this.started = false;
  }
}

/** 센서가 없을 때: 항상 "없음"이라고 답한다. */
export class NoOrientationSource implements OrientationSource {
  readonly available = false;
  readonly rateDegPerSec = 0;
  at(): boolean {
    return false;
  }
  stop(): void {}
}
