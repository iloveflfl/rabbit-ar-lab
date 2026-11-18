/**
 * 배포된 릴레이에 관람객처럼 붙어서 질문을 던져 본다 (전시 전 점검용).
 * 릴레이 주소는 desktop-server.env 의 RELAY_URL 을 쓴다. 데스크탑 서버가 켜져 있어야 답이 온다.
 *
 *   npm run ask -- "왜 영하 50도인데 기판은 73도야?"
 */
import { existsSync, readFileSync } from 'node:fs';
import { newUuid } from '@rabbit/shared';

const env = existsSync('desktop-server.env') ? readFileSync('desktop-server.env', 'utf8') : '';
const relay = (process.env.RELAY_URL ?? /^RELAY_URL=(.+)$/m.exec(env)?.[1] ?? '').trim().replace(/^http/, 'ws').replace(/\/$/, '');
const origin = process.env.ORIGIN ?? 'https://iloveflfl.github.io';
const questions = process.argv.slice(2).length ? process.argv.slice(2) : ['왜 영하 50도인데 기판은 73도야?'];
if (!relay) {
  console.error('RELAY_URL 이 없습니다 (desktop-server.env).');
  process.exit(1);
}

const health = await (await fetch(relay.replace(/^ws/, 'http') + '/health')).json();
console.log('health:', JSON.stringify(health));

const sessionId = newUuid();
const ws = new (WebSocket as any)(`${relay}/v1/chat`, { headers: { Origin: origin } }) as WebSocket;
await new Promise<void>((res, rej) => {
  ws.addEventListener('open', () => res());
  ws.addEventListener('error', () => rej(new Error('관람객 소켓을 열지 못했습니다 (Origin 제한 또는 주소 확인)')));
});
ws.send(JSON.stringify({ type: 'hello', sessionId, clientVersion: '1.0.0' }));

for (const q of questions) {
  const requestId = newUuid();
  const t0 = Date.now();
  let first = 0;
  const m = await new Promise<any>((res) => {
    const timer = setTimeout(() => res({ type: 'chat.error', code: '응답 없음(90초)' }), 90_000);
    const on = (ev: MessageEvent) => {
      const x = JSON.parse(String(ev.data));
      if (x.requestId !== requestId) return;
      if (x.type === 'chat.delta' && !first) first = Date.now() - t0;
      if (x.type === 'chat.final' || x.type === 'chat.error') {
        clearTimeout(timer);
        ws.removeEventListener('message', on);
        res(x);
      }
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ type: 'chat.request', requestId, sessionId, topic: 'general', message: q, clientVersion: '1.0.0' }));
  });
  console.log(`\nQ: ${q}`);
  if (m.type === 'chat.error') console.log(`   오류: ${m.code}`);
  else console.log(`A [${m.engine}, 첫 글자 ${(first / 1000).toFixed(1)}초, 전체 ${((Date.now() - t0) / 1000).toFixed(1)}초, 동작 ${m.animation}]\n   ${m.reply}`);
  if (questions.length > 1) await new Promise((r) => setTimeout(r, 10_500));
}
ws.close();
