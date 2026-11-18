/**
 * 토끼를 2D 캔버스에 그리고, 그 캔버스를 3D 공간의 평면 한 장에 붙인다.
 * 평면은 카메라를 바라본다(billboard). 토끼의 옆·뒷모습을 가진 3D 모델인 척하지 않는다.
 */
import * as THREE from 'three';
import { RABBIT } from '../ar/sceneLayout';
import { RabbitAnimator } from './clips';
import { VIEW, drawRabbit } from './rig';

export class RabbitCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly animator = new RabbitAnimator();

  constructor(readonly res = 1.5) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(VIEW.w * res);
    this.canvas.height = Math.round(VIEW.h * res);
    this.ctx = this.canvas.getContext('2d')!;
  }

  draw(dt: number): void {
    const pose = this.animator.update(dt);
    const { ctx, res } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(res, 0, 0, res, VIEW.ox * res, VIEW.oy * res);
    drawRabbit(ctx, pose);
  }
}

export class RabbitSprite {
  /** 발 위치가 원점인 그룹. 포스터 좌표계에 놓는다. */
  readonly group = new THREE.Group();
  /** 포스터 면에 떨어지는 부드러운 그림자 (깊이감을 준다) */
  readonly shadow: THREE.Mesh;
  readonly art: RabbitCanvas;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private pending = 0;
  private first = true;

  constructor(quality: 'high' | 'low') {
    this.art = new RabbitCanvas(quality === 'high' ? 1.25 : 1);
    this.texture = new THREE.CanvasTexture(this.art.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.premultiplyAlpha = true;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;

    const h = RABBIT.planeHeight;
    const w = (h * VIEW.w) / VIEW.h;
    const geo = new THREE.PlaneGeometry(w, h);
    // 원점을 발 위치로 옮긴다.
    geo.translate((0.5 - VIEW.ox / VIEW.w) * w, (VIEW.oy / VIEW.h - 0.5) * h, 0);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, premultipliedAlpha: true, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 50;
    this.group.add(this.mesh);

    const sc = document.createElement('canvas');
    sc.width = sc.height = 128;
    const g = sc.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(14,28,60,0.42)');
    grad.addColorStop(0.6, 'rgba(14,28,60,0.16)');
    grad.addColorStop(1, 'rgba(14,28,60,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const st = new THREE.CanvasTexture(sc);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false, toneMapped: false }));
    this.shadow.renderOrder = 6;
  }

  get animator(): RabbitAnimator {
    return this.art.animator;
  }

  set opacity(v: number) {
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = v;
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = v;
  }

  /** dt 만큼 애니메이션을 진행하고, 평면을 카메라 쪽으로 돌린다. */
  update(dt: number, camera: THREE.Camera): void {
    // 토끼 그림은 초당 30번만 다시 그린다: 2D 캔버스를 그리고 GPU 로 올리는 일이 매 프레임 하기엔 비싸다.
    // (평면의 위치·방향은 매 프레임 갱신되므로 움직임은 그대로 부드럽다.)
    this.pending += dt;
    if (this.pending >= 1 / 31 || this.first) {
      this.art.draw(this.pending);
      this.texture.needsUpdate = true;
      this.pending = 0;
      this.first = false;
    }
    const parent = this.group.parent;
    if (parent) {
      parent.getWorldQuaternion(this.q).invert();
      camera.getWorldQuaternion(this.q2);
      this.group.quaternion.copy(this.q.multiply(this.q2));
    }
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.shadow.geometry.dispose();
    ((this.shadow.material as THREE.MeshBasicMaterial).map as THREE.Texture).dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}
