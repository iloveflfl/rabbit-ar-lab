import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = resolve(__dirname, '../..');
const referencePoster = resolve(repoRoot, 'reference/poster_print_master_2526x3576.png');

/**
 * 개발 서버 전용 도구.
 *  - GET  /__ref/poster.png      : 비공개 reference/ 의 인쇄 원본 (타깃 컴파일·모의 카메라용). 빌드 결과에는 들어가지 않는다.
 *  - POST /__dev/save?name=…     : 타깃(.mind)·검증 스크린샷 저장.
 */
function devTools(): Plugin {
  return {
    name: 'rabbit-dev-tools',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__ref/poster.png', (_req, res) => {
        if (!existsSync(referencePoster)) {
          res.statusCode = 404;
          res.end('reference/poster_print_master_2526x3576.png 가 없습니다');
          return;
        }
        res.setHeader('content-type', 'image/png');
        createReadStream(referencePoster).pipe(res);
      });
      server.middlewares.use('/__dev/save', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (req.method !== 'POST' || !/^[a-z0-9_-]{1,40}\.(png|mind|json)$/.test(name)) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = name.endsWith('.png') ? resolve(__dirname, '.devshots') : resolve(__dirname, 'public/assets/targets');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, name), Buffer.concat(chunks));
          res.end(resolve(dir, name));
        });
      });
    },
  };
}

export default defineConfig({
  // 상대 경로 base: GitHub Pages 의 저장소 이름이 무엇이든 그대로 동작한다.
  base: './',
  plugins: [devTools()],
  server: { port: 5173, fs: { allow: [repoRoot] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2600,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html') } },
  },
  worker: { format: 'es' },
});
