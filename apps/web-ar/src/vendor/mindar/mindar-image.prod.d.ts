/** MindAR 1.2.5 (MIT, hiukim) 이미지 추적 — 벤더링한 배포 파일의 최소 타입 선언. */
export interface ControllerUpdate {
  type: 'updateMatrix' | 'processDone';
  targetIndex?: number;
  /** 열 우선 4×4. 추적을 놓치면 null. */
  worldMatrix?: number[] | null;
}
export class Controller {
  constructor(opts: {
    inputWidth: number;
    inputHeight: number;
    onUpdate?: (data: ControllerUpdate) => void;
    maxTrack?: number;
    warmupTolerance?: number | null;
    missTolerance?: number | null;
    filterMinCF?: number | null;
    filterBeta?: number | null;
    debugMode?: boolean;
  });
  inputWidth: number;
  inputHeight: number;
  addImageTargets(url: string): Promise<{ dimensions: Array<[number, number]> }>;
  addImageTargetsFromBuffer(buffer: ArrayBuffer): { dimensions: Array<[number, number]> };
  dummyRun(input: HTMLVideoElement | HTMLCanvasElement): void;
  getProjectionMatrix(): number[];
  processVideo(input: HTMLVideoElement | HTMLCanvasElement): void;
  stopProcessVideo(): void;
  dispose(): void;
}
export class Compiler {
  compileImageTargets(images: Array<HTMLImageElement | HTMLCanvasElement>, progress: (percent: number) => void): Promise<unknown[]>;
  exportData(): ArrayBuffer;
  importData(buffer: ArrayBuffer): Array<{ targetImage: { width: number; height: number } }>;
}
export const UI: unknown;
