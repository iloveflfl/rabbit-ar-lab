/**
 * 개발 전용 모의 카메라.
 * 벽에 걸린 A1 포스터를 가상의 휴대폰 카메라로 비춘 영상을 만들어 MediaStream 으로 내보낸다.
 * 실제 추적 파이프라인이 이 영상을 그대로 처리하므로, 실기기 없이 인식·정합을 확인할 수 있다.
 *
 * 함께 흉내 내는 것
 *  - 손떨림 (회전·위치)
 *  - 방향 센서 (자이로): 실제 카메라 방향 + 느린 표류 + 잡음
 *  - 세계 추적 (ARCore 역할): 실제 카메라 자세
 *
 * 화면에는 항상 "모의 카메라"라고 표시한다. 실기기 검증을 대신하지 않는다.
 */
import * as THREE from 'three';
import type { Intrinsics } from './pose/planarPose';
import { POSTER } from './sceneLayout';
import { OrientationHistory, type OrientationSource } from './sensors';

const W = 720;
const HGT = 1280;

interface PoseStamp {
  t: number;
  p: THREE.Vector3;
  q: THREE.Quaternion;
}

export class SimCamera {
  stream!: MediaStream;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, W / HGT, 0.05, 20);
  private raf = 0;
  private t0 = 0;
  /** true 면 천천히 좌우·앞뒤로 움직인다 */
  auto = true;
  yawDeg = 0;
  pitchDeg = 0;
  distance = 1.15;
  /** 포스터 중심에서 옆으로 비켜 선 거리 (m) */
  strafe = 0;
  /** 손떨림 세기 (1 = 보통 사람) */
  shake = 1;
  /** 포스터를 가려서 추적 상실을 시험한다 */
  covered = false;
  /** 자이로 표류 (도/초) 와 잡음 (도) */
  gyroDriftDegPerSec = 0.3;
  gyroNoiseDeg = 0.02;
  private cover!: THREE.Mesh;
  private sticker!: THREE.Mesh;
  private poster!: THREE.Mesh;
  private readonly poses: PoseStamp[] = [];
  private readonly gyro = new OrientationHistory();
  private readonly drift = new THREE.Quaternion();
  private lastT = 0;

  /** 포스터를 다른 크기로 인쇄한 상황을 흉내 낸다 (1 = A1). */
  posterScaleValue = 1;
  set posterScale(s: number) {
    this.posterScaleValue = s;
    this.poster.scale.setScalar(s);
    this.sticker.scale.setScalar(s);
    this.sticker.position.set(POSTER.widthM * 0.418 * s, -POSTER.heightM * 0.449 * s, 0.001);
  }

  intrinsics(): Intrinsics {
    const f = HGT / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return { fx: f, fy: f, cx: W / 2, cy: HGT / 2 };
  }

  async start(): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = HGT;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(W, HGT, false);

    const tex = await new THREE.TextureLoader().loadAsync('/__ref/poster.png');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshBasicMaterial({ color: '#B9B2A6' }));
    wall.position.z = -0.002;
    this.poster = new THREE.Mesh(new THREE.PlaneGeometry(POSTER.widthM, POSTER.heightM), new THREE.MeshBasicMaterial({ map: tex }));
    this.cover = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), new THREE.MeshBasicMaterial({ color: '#40454F' }));
    this.cover.position.z = 0.01;
    this.cover.visible = false;
    const qc = document.createElement('canvas');
    qc.width = qc.height = 58;
    const q = qc.getContext('2d')!;
    q.fillStyle = '#fff';
    q.fillRect(0, 0, 58, 58);
    q.fillStyle = '#000';
    for (let y = 0; y < 25; y++) for (let x = 0; x < 25; x++) if (((x * 7 + y * 13 + x * y) % 3 === 0) !== (x < 7 && y < 7)) q.fillRect(4 + x * 2, 4 + y * 2, 2, 2);
    const qt = new THREE.CanvasTexture(qc);
    qt.magFilter = THREE.NearestFilter;
    this.sticker = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 0.045), new THREE.MeshBasicMaterial({ map: qt }));
    this.sticker.position.set(POSTER.widthM * 0.418, -POSTER.heightM * 0.449, 0.001);
    this.sticker.visible = false;
    this.scene.add(wall, this.poster, this.cover, this.sticker);
    this.scene.background = new THREE.Color('#8E8A84');

    this.stream = canvas.captureStream(30);
    this.t0 = performance.now();
    this.lastT = this.t0;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.render();
    };
    loop();
  }

  set qrSticker(on: boolean) {
    this.sticker.visible = on;
  }

  private render(): void {
    const now = performance.now();
    const t = (now - this.t0) / 1000;
    let yaw = this.yawDeg;
    let pitch = this.pitchDeg;
    let dist = this.distance;
    if (this.auto) {
      yaw = Math.sin(t * 0.35) * 16;
      pitch = Math.sin(t * 0.23 + 1) * 5;
      dist = 1.15 + Math.sin(t * 0.17) * 0.12;
    }
    const y = THREE.MathUtils.degToRad(yaw);
    const p = THREE.MathUtils.degToRad(pitch);
    const cam = this.camera;
    cam.position.set(Math.sin(y) * Math.cos(p) * dist + this.strafe, Math.sin(p) * dist, Math.cos(y) * Math.cos(p) * dist);
    cam.lookAt(this.strafe * 0.6, 0, 0);
    // 손떨림: 사람 손은 주로 "돌리는" 쪽으로 떨린다 (약 ±0.25°), 위치는 몇 mm.
    const s = this.shake;
    cam.rotateX(THREE.MathUtils.degToRad((Math.sin(t * 9.1) * 0.16 + Math.sin(t * 23.7) * 0.07) * s));
    cam.rotateY(THREE.MathUtils.degToRad((Math.sin(t * 7.3 + 1) * 0.2 + Math.sin(t * 19.3) * 0.08) * s));
    cam.rotateZ(THREE.MathUtils.degToRad(Math.sin(t * 5.1 + 2) * 0.1 * s));
    cam.position.x += Math.sin(t * 6.1) * 0.002 * s;
    cam.position.y += Math.sin(t * 4.7) * 0.002 * s;
    cam.updateMatrixWorld();

    this.poses.push({ t: now, p: cam.position.clone(), q: cam.quaternion.clone() });
    if (this.poses.length > 240) this.poses.shift();

    // 가짜 자이로: 실제 방향에 느린 표류(세로축 회전)와 잡음을 더한다.
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    this.drift.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(this.gyroDriftDegPerSec * dt)));
    const n = THREE.MathUtils.degToRad(this.gyroNoiseDeg);
    const noise = new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * n, (Math.random() - 0.5) * n, (Math.random() - 0.5) * n));
    this.gyro.push(now, this.drift.clone().multiply(cam.quaternion).multiply(noise));

    this.cover.visible = this.covered;
    this.renderer.render(this.scene, cam);
  }

  /** 주어진 시각의 실제 카메라 자세 (세계 추적 역할). */
  poseAt(time: number, outP: THREE.Vector3, outQ: THREE.Quaternion): boolean {
    const b = this.poses;
    if (!b.length) return false;
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= time) {
        const nx = b[Math.min(b.length - 1, i + 1)];
        const span = nx.t - b[i].t;
        const k = span > 0 ? Math.min(1, (time - b[i].t) / span) : 0;
        outP.copy(b[i].p).lerp(nx.p, k);
        outQ.copy(b[i].q).slerp(nx.q, k);
        return true;
      }
    }
    outP.copy(b[0].p);
    outQ.copy(b[0].q);
    return true;
  }

  /** 가짜 방향 센서 */
  orientationSource(): OrientationSource {
    const gyro = this.gyro;
    return {
      available: true,
      get rateDegPerSec() {
        return gyro.rateDegPerSec;
      },
      at: (time, out) => gyro.at(time, out),
      stop: () => {},
    };
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.renderer?.dispose();
  }
}
