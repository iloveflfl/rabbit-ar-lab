/**
 * 추적 워커: 무거운 특징점 검출·추적(TensorFlow.js WebGL + 동기 GPU 읽기)을 화면을 그리는 스레드 밖에서 돌린다.
 * 이렇게 해야 추적이 느린 기기에서도 화면은 끊기지 않는다(자세는 센서/세계 추적이 그 사이를 메운다).
 */
import './workerShim';
import { type CoreFrame, type CoreInit, type CoreResult, TrackerCore } from './mindarBridge';
import type { Intrinsics } from './pose/planarPose';

export type ToWorker =
  | { type: 'init'; cfg: CoreInit }
  | { type: 'frame'; frame: CoreFrame; bitmap?: ImageBitmap; pixels?: Uint8Array }
  | { type: 'intrinsics'; K: Intrinsics }
  | { type: 'reset' }
  | { type: 'stop' };

export type FromWorker = { type: 'ready' } | { type: 'error'; message: string } | { type: 'result'; result: CoreResult; pixels?: Uint8Array };

const core = new TrackerCore();
const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);
let ready = false;

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init':
        await core.init(m.cfg);
        ready = true;
        post({ type: 'ready' });
        break;
      case 'frame': {
        if (!ready) return;
        let result: CoreResult;
        if (m.bitmap) {
          result = await core.process(m.bitmap, m.frame);
          m.bitmap.close();
        } else if (m.pixels) {
          result = await core.processPixels(m.pixels, m.frame);
        } else return;
        const transfer: Transferable[] = [];
        if (result.corr) transfer.push(result.corr.buffer);
        // 픽셀 버퍼는 돌려보내 다시 쓰게 한다(매번 새로 할당하지 않도록).
        if (m.pixels) transfer.push(m.pixels.buffer);
        post({ type: 'result', result, pixels: m.pixels }, transfer);
        break;
      }
      case 'intrinsics':
        if (ready) core.setIntrinsics(m.K);
        break;
      case 'reset':
        core.reset();
        break;
      case 'stop':
        core.stop();
        self.close();
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
