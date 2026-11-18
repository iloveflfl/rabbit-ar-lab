/**
 * 개발용 가짜 단말. 실제 Galaxy 앱 대신 릴레이에 붙어서 사전제작 답변을 스트리밍한다.
 * 답변에는 engine: "mock" 이 붙으므로 화면에서 실제 온디바이스 LLM 과 구분된다.
 *
 *   npm run relay:dev          (다른 터미널)
 *   npm run mock-device        (기본: ws://127.0.0.1:8787, 토큰은 .dev.vars.example 값)
 *   RELAY_URL=wss://… DEVICE_TOKEN=… npm run mock-device
 */
import { CLIENT_VERSION, PROTOCOL_VERSION, type DeviceChatRequest } from '@rabbit/shared';
import { matchCanned } from '@rabbit/content';

export interface MockDevice {
  close(): void;
  ready: Promise<void>;
}

export function startMockDevice(relayUrl: string, token: string, opts: { chunkDelayMs?: number; log?: boolean } = {}): MockDevice {
  const delay = opts.chunkDelayMs ?? 40;
  const log = (...a: unknown[]) => opts.log !== false && console.log('[mock-device]', ...a);
  const url = relayUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/device/connect';
  // Node 의 WebSocket(undici)은 두 번째 인자로 headers 를 받는다.
  const ws = new (WebSocket as any)(url, { headers: { Authorization: `Bearer ${token}` } }) as WebSocket;
  const cancelled = new Set<string>();

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, deviceVersion: CLIENT_VERSION, engine: 'mock' }));
    });
    ws.addEventListener('error', () => reject(new Error('device socket error (토큰이 틀렸거나 릴레이가 꺼져 있음)')));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'hello.ack') {
        log('online');
        resolve();
      } else if (m.type === 'cancel') {
        cancelled.add(m.requestId);
      } else if (m.type === 'chat.request') {
        void answer(m as DeviceChatRequest);
      }
    });
  });
  ws.addEventListener('close', (ev) => log('closed', ev.code));

  // 실제 단말처럼 한 번에 하나씩만 처리한다.
  let chain: Promise<void> = Promise.resolve();
  function answer(req: DeviceChatRequest): Promise<void> {
    chain = chain.then(async () => {
      const a = matchCanned(req.message, req.topic);
      log(`Q(${req.sessionId.slice(0, 8)}): ${req.message} → ${a.id}`);
      const base = { requestId: req.requestId, sessionId: req.sessionId };
      for (let i = 0; i < a.reply.length; i += 12) {
        if (cancelled.has(req.requestId) || ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ type: 'chat.delta', ...base, text: a.reply.slice(i, i + 12) }));
        await new Promise((r) => setTimeout(r, delay));
      }
      if (cancelled.has(req.requestId) || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'chat.final', ...base, reply: a.reply, animation: a.animation, highlight: a.highlight, sourceFactIds: a.sourceFactIds, engine: 'mock' }));
    });
    return chain;
  }

  return { close: () => ws.close(1000, 'bye'), ready };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/mock-device.ts');
if (isMain) {
  const relay = process.env.RELAY_URL ?? 'ws://127.0.0.1:8787';
  const token = process.env.DEVICE_TOKEN ?? 'local-dev-token-change-me-0123456789';
  startMockDevice(relay, token).ready.catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
