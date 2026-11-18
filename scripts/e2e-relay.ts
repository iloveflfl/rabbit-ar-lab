/**
 * 로컬 E2E: wrangler dev(miniflare)로 실제 Worker + Durable Object 를 띄우고
 * 가짜 단말 1대 + 관람객 2명으로 전 구간을 검증한다. Cloudflare 계정이 필요 없다.
 *
 *   npm run test:e2e
 */
import { spawn, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { newUuid } from '@rabbit/shared';
import { startMockDevice } from './mock-device';

const PORT = 8799;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'e2e-token-0123456789-abcdefghijklmnop';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function visitor() {
  const sessionId = newUuid();
  const ws = new WebSocket(`${WS}/v1/chat`);
  const inbox: any[] = [];
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) waiters.splice(i, 1)[0].resolve(m);
  });
  const waitFor = (pred: (m: any) => boolean, ms = 8000) =>
    new Promise<any>((res, rej) => {
      const hit = inbox.find(pred);
      if (hit) return res(hit);
      const t = setTimeout(() => rej(new Error('timeout waiting for frame')), ms);
      waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
    });
  const open = new Promise<void>((res) => ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', sessionId, clientVersion: '1.0.0' }));
    res();
  }));
  const ask = (message: string) => {
    const requestId = newUuid();
    ws.send(JSON.stringify({ type: 'chat.request', requestId, sessionId, topic: 'general', message, clientVersion: '1.0.0' }));
    return requestId;
  };
  return { ws, sessionId, inbox, waitFor, open, ask };
}

async function main() {
  const cwd = resolve(import.meta.dirname, '../apps/relay-worker');
  const child = spawn(`npx wrangler dev --port ${PORT} --var DEVICE_TOKEN:${TOKEN} --show-interactive-dev-session=false`, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const stop = () => {
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {
      /* 이미 종료 */
    }
  };

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(500);
      up = await fetch(`${HTTP}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up) throw new Error('wrangler dev 가 뜨지 않았습니다:\n' + out.slice(-2000));

    const h0 = await (await fetch(`${HTTP}/health`)).json();
    check('단말 연결 전 /health 는 offline', h0.status === 'offline', JSON.stringify(h0));
    check('/health 는 상세 정보를 노출하지 않는다', Object.keys(h0).sort().join() === 'connectedAt,queueDepth,status,version');

    const a = visitor();
    await a.open;
    check('관람객 hello.ack(offline)', (await a.waitFor((m) => m.type === 'hello.ack')).status === 'offline');
    const r0 = a.ask('왜 영하 50도인데 기판은 73도야?');
    check('오프라인이면 chat.error(offline)', (await a.waitFor((m) => m.type === 'chat.error' && m.requestId === r0)).code === 'offline');

    const bad = await fetch(`${HTTP}/device/status`, { headers: { Authorization: 'Bearer wrong-token-wrong-token-wrong' } });
    check('틀린 토큰은 401', bad.status === 401);
    const noUpgrade = await fetch(`${HTTP}/device/connect`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    check('/device/connect 는 WebSocket 만 받는다', noUpgrade.status === 426);
    let wrongRejected = false;
    await startMockDevice(WS, 'wrong-token-wrong-token-wrong', { log: false }).ready.catch(() => (wrongRejected = true));
    check('틀린 토큰으로는 단말 소켓을 열 수 없다', wrongRejected);

    const dev = startMockDevice(WS, TOKEN, { log: false, chunkDelayMs: 15 });
    await dev.ready;
    check('단말 연결 뒤 관람객에게 status(online) 방송', (await a.waitFor((m) => m.type === 'status' && m.status === 'online')).status === 'online');
    check('단말 연결 뒤 /health 는 online', (await (await fetch(`${HTTP}/health`)).json()).status === 'online');

    const b = visitor();
    await b.open;
    await b.waitFor((m) => m.type === 'hello.ack');
    const ra = a.ask('왜 영하 50도인데 기판은 73도야?');
    const rb = b.ask('냉각을 왜 3분씩 했어?');
    const [fa, fb] = await Promise.all([a.waitFor((m) => m.type === 'chat.final' && m.requestId === ra), b.waitFor((m) => m.type === 'chat.final' && m.requestId === rb)]);
    check('A 는 가열 답을 받는다', fa.animation === 'show_heating' && fa.reply.includes('73'), fa.reply.slice(0, 30));
    check('B 는 냉각 답을 받는다', fb.animation === 'show_cooling' && fb.reply.includes('14.5'), fb.reply.slice(0, 30));
    check('엔진 표시가 mock 이다', fa.engine === 'mock' && fb.engine === 'mock');
    const leakA = a.inbox.some((m) => m.requestId === rb || m.sessionId === b.sessionId);
    const leakB = b.inbox.some((m) => m.requestId === ra || m.sessionId === a.sessionId);
    check('두 세션의 프레임이 섞이지 않는다', !leakA && !leakB);
    const deltasA = a.inbox.filter((m) => m.type === 'chat.delta' && m.requestId === ra).map((m) => m.text).join('');
    check('스트리밍 조각을 이으면 최종 답과 같다', deltasA === fa.reply);

    const dupId = a.ask('SiC 식각은 뭐야?');
    await a.waitFor((m) => m.type === 'chat.final' && m.requestId === dupId);
    a.ws.send(JSON.stringify({ type: 'chat.request', requestId: dupId, sessionId: a.sessionId, topic: 'general', message: '다시', clientVersion: '1.0.0' }));
    check('requestId 재사용은 duplicate_request', (await a.waitFor((m) => m.type === 'chat.error' && m.requestId === dupId)).code === 'duplicate_request');

    const post = await fetch(`${HTTP}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'chat.request', requestId: newUuid(), sessionId: newUuid(), topic: 'general', message: 'Mo 식각률은?', clientVersion: '1.0.0' }),
    });
    const pj = await post.json();
    check('POST /v1/chat 단발 요청', post.status === 200 && pj.type === 'chat.final' && pj.reply.includes('95'), String(pj.reply ?? pj.error).slice(0, 30));

    const admin = await (await fetch(`${HTTP}/device/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    check('소유자 상태 API 는 토큰으로만 열린다', admin.engine === 'mock' && admin.budgetUsed >= 4, JSON.stringify(admin));

    a.ws.send(JSON.stringify({ type: 'chat.request', evil: true }));
    await sleep(300);
    check('스키마 위반 프레임은 연결을 끊는다', a.ws.readyState !== a.ws.OPEN);

    dev.close();
    check('단말 종료 뒤 status(offline) 방송', (await b.waitFor((m) => m.type === 'status' && m.status === 'offline')).status === 'offline');
    check('단말 종료 뒤 /health 는 offline', (await (await fetch(`${HTTP}/health`)).json()).status === 'offline');
    b.ws.close();
  } finally {
    stop();
  }
  console.log(failed === 0 ? '\nE2E OK' : `\nE2E FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
