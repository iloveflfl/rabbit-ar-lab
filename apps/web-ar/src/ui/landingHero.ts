/**
 * 첫 화면의 주인공: 이 연구에 쓴 ICP-RIE 장비의 3D 단면이 천천히 돌아간다.
 * AR 안의 "장비" 슬라이드와 같은 모형(stage/props 의 Reactor)을 그대로 쓴다.
 * WebGL 을 못 쓰는 기기에서는 조용히 아무것도 그리지 않는다.
 */
import * as THREE from 'three';
import { Motion } from '../motion/tween';
import { Label } from '../stage/labels';
import { loadPosterFonts } from '../stage/posterArt';
import { Reactor } from '../stage/props';

export class LandingHero {
  readonly el = document.createElement('div');
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 0.05, 30);
  private readonly motion = new Motion();
  private reactor: Reactor | null = null;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver | null = null;
  private tiltX = 0;
  private tiltY = 0;
  private readonly onMove = (e: PointerEvent) => {
    this.tiltX = (e.clientX / window.innerWidth - 0.5) * 0.5;
    this.tiltY = (e.clientY / window.innerHeight - 0.5) * 0.25;
  };

  constructor() {
    this.el.className = 'hero3d';
    this.el.setAttribute('aria-hidden', 'true');
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    } catch {
      return;
    }
    const r = this.renderer;
    r.setClearColor(0x000000, 0);
    this.el.append(r.domElement);
    const hemi = new THREE.HemisphereLight('#FFFFFF', '#5A6C99', 1.35);
    const key = new THREE.DirectionalLight('#FFFFFF', 2.2);
    key.position.set(-0.5, 0.9, 1.4);
    const rim = new THREE.DirectionalLight('#8FB8FF', 1.1);
    rim.position.set(0.9, -0.2, 0.8);
    this.scene.add(hemi, key, rim);
    this.reactor = new Reactor('high', { w: 1, h: 0.86 });
    this.scene.add(this.reactor.group);
    this.reactor.play(this.motion);
    void loadPosterFonts().then(() => Label.refreshAll());

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
    window.addEventListener('pointermove', this.onMove, { passive: true });
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private layout(): void {
    const r = this.renderer;
    if (!r) return;
    const w = this.el.clientWidth || 1;
    const h = this.el.clientHeight || 1;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const r = this.renderer;
    if (!r || !this.reactor || document.hidden) return;
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    this.motion.update(dt);
    this.reactor.update(dt, this.motion.time);
    // 장비 전체(이름표 포함)가 화면에 들어오도록 거리를 잡는다.
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max(1.02 / (2 * tan), 1.12 / (2 * tan * this.camera.aspect));
    const k = 1 - Math.exp(-4 * dt);
    this.camera.position.x += (this.tiltX * dist * 0.5 - this.camera.position.x) * k;
    this.camera.position.y += (0.02 - this.tiltY * dist * 0.5 - this.camera.position.y) * k;
    this.camera.position.z = dist + 0.25;
    this.camera.lookAt(0, 0, 0.2);
    r.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener('pointermove', this.onMove);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    Label.reset();
  }
}
