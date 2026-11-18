import * as THREE from 'three';
import { FONT_BODY, FONT_DISPLAY } from './posterArt';

export interface LabelOpts {
  /** 글자 높이(포스터 단위) */
  size: number;
  color?: string;
  display?: boolean;
  weight?: number;
  /** 알약 모양 배경색. 없으면 글자만. */
  bg?: string;
  /** 글자 외곽선(밝은 배경 위 가독성) */
  halo?: string;
}

const PX = 72;

/** 캔버스 글자를 붙인 평면 한 장. 3D 그래프의 값·이름표로 쓴다. */
export class Label {
  readonly mesh: THREE.Mesh;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private current = '';

  constructor(text: string, private readonly opts: LabelOpts) {
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.premultiplyAlpha = true;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, premultipliedAlpha: true, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.renderOrder = 30;
    this.setText(text);
  }

  setText(text: string): void {
    if (text === this.current) return;
    this.current = text;
    const o = this.opts;
    const font = `${o.weight ?? (o.display === false ? 700 : 400)} ${PX}px ${o.display === false ? FONT_BODY : FONT_DISPLAY}`;
    const c = this.canvas.getContext('2d')!;
    c.font = font;
    const padX = o.bg ? PX * 0.5 : PX * 0.16;
    const padY = o.bg ? PX * 0.22 : PX * 0.14;
    const w = Math.ceil(c.measureText(text).width + padX * 2);
    const h = Math.ceil(PX * 1.12 + padY * 2);
    // 캔버스 크기가 바뀌면 GPU 텍스처를 새로 만들어야 한다.
    if (this.canvas.width !== w || this.canvas.height !== h) this.texture.dispose();
    this.canvas.width = w;
    this.canvas.height = h;
    c.font = font;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    if (o.bg) {
      c.fillStyle = o.bg;
      c.beginPath();
      c.roundRect(0, 0, w, h, h / 2);
      c.fill();
    }
    if (o.halo) {
      c.lineJoin = 'round';
      c.lineWidth = PX * 0.2;
      c.strokeStyle = o.halo;
      c.strokeText(text, w / 2, h / 2 + PX * 0.05);
    }
    c.fillStyle = o.color ?? '#12264A';
    c.fillText(text, w / 2, h / 2 + PX * 0.05);
    this.texture.needsUpdate = true;
    const unit = o.size / PX;
    this.mesh.scale.set(w * unit, h * unit, 1);
    this.baseScale.copy(this.mesh.scale);
  }

  /** setText 가 정한 기본 크기. pop 애니메이션은 이 값에 배율을 곱한다. */
  readonly baseScale = new THREE.Vector3(1, 1, 1);
  set pop(k: number) {
    this.mesh.scale.set(this.baseScale.x * k, this.baseScale.y * k, 1);
    this.mesh.visible = k > 0.01;
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
