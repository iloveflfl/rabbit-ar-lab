/**
 * 개발용: 인쇄 원본 → 이미지 타깃(.mind) 컴파일.  npm run dev 후 /tools/compile-target.html 에서 실행.
 * 재현 절차와 결과 기록은 scripts/compile_target.md 참고.
 */
import { ORIGINAL_QR_ZONE, TARGETS } from '../ar/sceneLayout';
import { Compiler } from '../vendor/mindar/mindar-image.prod.js';

const logEl = document.getElementById('log')!;
const log = (s: string) => (logEl.textContent += s + '\n');

async function loadPoster(): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = '/__ref/poster.png';
  await img.decode();
  return img;
}

/** 타깃 하나를 잘라 낸다. QR 스티커가 붙을 자리는 주변 바탕색으로 덮어 특징점 후보에서 뺀다. */
function cropTarget(img: HTMLImageElement, i: number): HTMLCanvasElement {
  const t = TARGETS[i];
  const sx = t.crop.u0 * img.width;
  const sy = t.crop.v0 * img.height;
  const sw = (t.crop.u1 - t.crop.u0) * img.width;
  const sh = (t.crop.v1 - t.crop.v0) * img.height;
  const c = document.createElement('canvas');
  c.width = t.compileWidth;
  c.height = Math.round((t.compileWidth * sh) / sw);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const q = ORIGINAL_QR_ZONE;
  const k = c.width / sw;
  const qx = (q.u0 * img.width - sx) * k;
  const qy = (q.v0 * img.height - sy) * k;
  const qw = (q.u1 - q.u0) * img.width * k;
  const qh = (q.v1 - q.v0) * img.height * k;
  if (qy + qh > 0 && qy < c.height) {
    const px = g.getImageData(Math.max(0, Math.round(qx + qw / 2)), Math.min(c.height - 1, Math.max(0, Math.round(qy + qh / 2))), 1, 1).data;
    g.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
    g.fillRect(qx, qy, qw, qh);
  }
  return c;
}

export async function compile(): Promise<{ bytes: number; sizes: string[] }> {
  const img = await loadPoster();
  log(`원본 ${img.width}×${img.height}`);
  const canvases = TARGETS.map((_, i) => cropTarget(img, i));
  const previews = document.getElementById('previews')!;
  previews.replaceChildren(...canvases);
  canvases.forEach((c, i) => log(`타깃 ${i} (${TARGETS[i].id}): ${c.width}×${c.height}`));
  const compiler = new Compiler();
  const t0 = performance.now();
  let lastShown = -10;
  await compiler.compileImageTargets(canvases, (p) => {
    if (p - lastShown >= 10) {
      lastShown = p;
      log(`  ${p.toFixed(0)}%`);
    }
  });
  const buf = compiler.exportData();
  log(`컴파일 완료: ${(buf.byteLength / 1024).toFixed(0)} KB, ${((performance.now() - t0) / 1000).toFixed(1)}초`);
  const res = await fetch('/__dev/save?name=poster.mind', { method: 'POST', body: buf });
  log(`저장: ${await res.text()}`);
  const meta = { compiledAt: new Date().toISOString(), source: 'reference/poster_print_master_2526x3576.png', targets: TARGETS.map((t, i) => ({ ...t, pixels: [canvases[i].width, canvases[i].height] })), bytes: buf.byteLength };
  await fetch('/__dev/save?name=poster.json', { method: 'POST', body: JSON.stringify(meta, null, 2) });
  return { bytes: buf.byteLength, sizes: canvases.map((c) => `${c.width}x${c.height}`) };
}

(window as unknown as { __compile: typeof compile }).__compile = compile;
document.getElementById('go')!.addEventListener('click', () => void compile().catch((e) => log('실패: ' + e)));
