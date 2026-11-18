/** AR 모듈(용량이 크다)을 내려받기 전에도 쓸 수 있는 가벼운 공용 조각. */

export type TrackState = 'starting' | 'searching' | 'tracking' | 'lost';

export class CameraError extends Error {
  constructor(readonly kind: 'denied' | 'unavailable' | 'insecure' | 'target' | 'unknown', message: string) {
    super(message);
  }
}

/** 이 브라우저가 WebXR 몰입형 AR 을 지원하는가 (Android Chrome + ARCore). */
export async function xrSupported(): Promise<boolean> {
  const xr = (navigator as unknown as { xr?: { isSessionSupported?: (m: string) => Promise<boolean> } }).xr;
  if (!xr?.isSessionSupported || typeof (window as unknown as { XRWebGLBinding?: unknown }).XRWebGLBinding === 'undefined') return false;
  try {
    return await xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

/** 사용자가 고른 AR 방식. 'xr' = 공간 고정(ARCore, 보통 30fps), 'video' = 부드럽게(카메라 영상+자이로, 최대 60fps). */
export type ArMode = 'xr' | 'video';
export function preferredArMode(): ArMode | null {
  try {
    const v = localStorage.getItem('rabbit.arMode');
    return v === 'xr' || v === 'video' ? v : null;
  } catch {
    return null;
  }
}
export function rememberArMode(m: ArMode): void {
  try {
    localStorage.setItem('rabbit.arMode', m);
  } catch {
    /* 저장 못 해도 된다 */
  }
}

/** 이 기기에서 WebXR 경로가 통했는지 기억해 둔다 (다음에 헛걸음하지 않도록). */
export function rememberXr(v: 'ok' | 'bad'): void {
  try {
    localStorage.setItem('rabbit.xr', v);
  } catch {
    /* 저장 못 해도 된다 */
  }
}
export function xrKnownBad(): boolean {
  try {
    return localStorage.getItem('rabbit.xr') === 'bad';
  } catch {
    return false;
  }
}
