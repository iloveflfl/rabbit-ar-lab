/**
 * 개발 전용 모의 카메라.
 * 벽에 걸린 A1 포스터를 가상의 휴대폰 카메라로 비춘 영상을 만들어 MediaStream 으로 내보낸다.
 * 실제 추적 파이프라인(MindAR)이 이 영상을 그대로 처리하므로, 실기기 없이 인식·정합을 확인할 수 있다.
 * 화면에는 항상 "모의 카메라"라고 표시한다. 실기기 검증을 대신하지 않는다.
 */
import * as THREE from 'three';
import { POSTER } from './sceneLayout';

export class SimCamera {
  stream!: MediaStream;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 720 / 1280, 0.05, 20);
  private raf = 0;
  private t0 = 0;
  /** true 면 천천히 좌우·앞뒤로 움직인다 */
  auto = true;
  /** 수동 자세 (auto=false 일 때) */
  yawDeg = 0;
  pitchDeg = 0;
  distance = 1.15;
  /** 포스터를 가려서 추적 상실을 시험한다 */
  covered = false;
  private cover!: THREE.Mesh;
  /** 포스터 위 QR 스티커(시험용) */
  private sticker!: THREE.Mesh;

  async start(): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(720, 1280, false);

    const tex = await new THREE.TextureLoader().loadAsync('/__ref/poster.png');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshBasicMaterial({ color: '#B9B2A6' }));
    wall.position.z = -0.002;
    const poster = new THREE.Mesh(new THREE.PlaneGeometry(POSTER.widthM, POSTER.heightM), new THREE.MeshBasicMaterial({ map: tex }));
    this.cover = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), new THREE.MeshBasicMaterial({ color: '#40454F' }));
    this.cover.position.z = 0.01;
    this.cover.visible = false;
    // QR 스티커 자리(Conclusions 오른쪽 빈 곳)에 붙인 흑백 무늬
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
    this.scene.add(wall, poster, this.cover, this.sticker);
    this.scene.background = new THREE.Color('#8E8A84');

    this.stream = canvas.captureStream(30);
    this.t0 = performance.now();
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
    const t = (performance.now() - this.t0) / 1000;
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
    this.camera.position.set(Math.sin(y) * Math.cos(p) * dist, Math.sin(p) * dist, Math.cos(y) * Math.cos(p) * dist);
    // 손떨림
    this.camera.position.x += Math.sin(t * 7.1) * 0.0015;
    this.camera.position.y += Math.sin(t * 5.3) * 0.0015;
    this.camera.lookAt(0, 0, 0);
    this.cover.visible = this.covered;
    this.renderer.render(this.scene, this.camera);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.renderer?.dispose();
  }
}
