/**
 * AR 없이 보기: 카메라·추적 없이 같은 스테이지를 3D 로 보여 준다.
 * 화면을 끌면 시점이 조금 돌아가 깊이(시차)를 볼 수 있고, 장면을 고르면 그 패널로 다가간다.
 * 이 모드는 AR 인 척하지 않는다(카메라 영상이 없다).
 */
import * as THREE from 'three';
import type { HighlightId } from '@rabbit/shared';
import type { LabStage } from '../stage/stage';
import { H } from './sceneLayout';

export class ViewerView {
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  private raf = 0;
  private running = false;
  private last = 0;
  private yaw = 0;
  private pitch = 0;
  private yawT = 0;
  private pitchT = 0;
  private readonly look = new THREE.Vector3();
  private readonly lookT = new THREE.Vector3();
  private dist = 5;
  private distT = 5;
  private dragging = false;
  private moved = 0;
  private downAt = 0;
  private px = 0;
  private py = 0;
  private idle = 0;
  /** 아래쪽 UI(자막·채팅)가 가리는 높이(px). 그만큼 화면 중심을 위로 올린다. */
  bottomInset = 0;
  private readonly ndc = new THREE.Vector2();
  private readonly onResize = () => this.layout();

  constructor(private readonly container: HTMLElement, private readonly stage: LabStage, private readonly onTap: (panel: HighlightId | null) => void) {}

  get glCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  async start(): Promise<void> {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: import.meta.env.DEV });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'viewer-canvas';
    this.container.appendChild(this.renderer.domElement);
    await this.stage.init(this.renderer);

    // 포스터가 걸린 벽과 종이 그림자
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(1, H), new THREE.MeshBasicMaterial({ color: '#F4F8FC' }));
    const shadowTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(128, 128, 60, 128, 128, 128);
      grad.addColorStop(0, 'rgba(0,8,30,0.55)');
      grad.addColorStop(1, 'rgba(0,8,30,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
      return new THREE.CanvasTexture(c);
    })();
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, H * 1.3), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.position.set(0.02, -0.04, -0.01);
    paper.position.z = -0.001;
    this.scene.add(shadow, paper, this.stage.root, this.camera);

    this.layout();
    this.frameTarget(true);
    window.addEventListener('resize', this.onResize);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);

    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.stage.reveal();
  }

  private layout(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.stage.quality === 'low' ? 1.25 : 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 강조 중인 패널(없으면 포스터 전체)이 UI 에 가리지 않는 영역에 들어오도록 카메라 목표를 잡는다. */
  private frameTarget(snap = false): void {
    const b = this.stage.focusBounds();
    const full = this.stage.focusPanel === null;
    const h = this.container.clientHeight || 1;
    const usable = Math.max(0.35, 1 - this.bottomInset / h - 0.07);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const margin = full ? 1.06 : 1.5;
    // 토끼가 패널 옆에 서므로 가로는 조금 더 넉넉히
    const needH = (b.h * margin) / (2 * tanV * usable);
    const needW = ((b.w + (full ? 0.1 : 0.5)) * margin) / (2 * tanV * this.camera.aspect);
    this.distT = Math.max(needH, needW);
    // UI 가 아래를 가리는 만큼 시선을 아래로 내려 콘텐츠를 위로 올린다.
    const shift = this.distT * tanV * (1 - usable - 0.03);
    this.lookT.set(b.cx, b.cy - shift, 0);
    if (snap) {
      this.dist = this.distT * 1.25;
      this.look.copy(this.lookT);
    }
  }

  private readonly onDown = (e: PointerEvent) => {
    this.dragging = true;
    this.moved = 0;
    this.downAt = performance.now();
    this.px = e.clientX;
    this.py = e.clientY;
    this.idle = 0;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  private readonly onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.px;
    const dy = e.clientY - this.py;
    this.px = e.clientX;
    this.py = e.clientY;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.yawT = THREE.MathUtils.clamp(this.yawT - dx * 0.25, -32, 32);
    this.pitchT = THREE.MathUtils.clamp(this.pitchT + dy * 0.18, -18, 18);
  };
  private readonly onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.moved < 10 && performance.now() - this.downAt < 450) {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.onTap(this.stage.pick(this.ndc, this.camera));
    }
  };

  private readonly frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    this.frameTarget();

    // 손을 떼고 있으면 천천히 흔들려 깊이가 보이게 한다.
    this.idle += dt;
    const sway = Math.min(1, Math.max(0, (this.idle - 1.5) / 2));
    if (!this.dragging && this.idle > 6) {
      this.yawT *= 1 - dt * 0.6;
      this.pitchT *= 1 - dt * 0.6;
    }
    const k = 1 - Math.exp(-6 * dt);
    this.yaw += (this.yawT + Math.sin(now / 2600) * 7 * sway - this.yaw) * k;
    this.pitch += (this.pitchT + Math.sin(now / 3400 + 1) * 2.5 * sway - this.pitch) * k;
    const k2 = 1 - Math.exp(-3.2 * dt);
    this.dist += (this.distT - this.dist) * k2;
    this.look.lerp(this.lookT, k2);

    const y = THREE.MathUtils.degToRad(this.yaw);
    const p = THREE.MathUtils.degToRad(this.pitch);
    this.camera.position.set(this.look.x + Math.sin(y) * Math.cos(p) * this.dist, this.look.y + Math.sin(p) * this.dist, Math.cos(y) * Math.cos(p) * this.dist);
    this.camera.lookAt(this.look);

    this.stage.update(dt, this.camera, this.renderer.domElement.height);
    this.renderer.render(this.scene, this.camera);
  };

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    if (this.renderer) {
      this.scene.remove(this.stage.root);
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
  }
}
