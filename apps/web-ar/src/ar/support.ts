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

/** 예전 버전이 저장해 둔 "60fps 방식" 선택을 지운다. 이제 공간 고정이 항상 기본이다. */
export function forgetArMode(): void {
  try {
    localStorage.removeItem('rabbit.arMode');
  } catch {
    /* 지우지 못해도 된다 */
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
