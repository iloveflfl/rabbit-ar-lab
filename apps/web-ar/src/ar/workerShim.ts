/**
 * 워커 안에서 MindAR(TensorFlow.js) 가 돌 수 있도록, 그것이 기대하는 브라우저 전역을 채워 준다.
 * 반드시 MindAR 를 import 하기 "전에" import 해야 한다.
 */
const g = self as unknown as Record<string, unknown>;

if (typeof g.window === 'undefined') g.window = self;
if (typeof g.document === 'undefined') {
  g.document = {
    // MindAR 와 tfjs 는 캔버스를 만들 때만 document 를 쓴다.
    createElement: (tag: string) => {
      if (tag === 'canvas') return new OffscreenCanvas(300, 150);
      throw new Error(`worker shim: createElement(${tag}) 는 지원하지 않습니다`);
    },
  };
}
if (typeof g.localStorage === 'undefined') {
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
if (typeof g.requestAnimationFrame === 'undefined') {
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0);
}

export {};
