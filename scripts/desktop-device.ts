/**
 * 데스크탑 단말. 폰 앱 대신 이 PC 가 릴레이에 붙어서 LM Studio 의 로컬 모델(Gemma 4)로 답한다.
 * PC 는 바깥으로 접속만 하므로 포트를 열 필요가 없고, 관람객이 보는 주소는 릴레이(workers.dev)로 고정된다.
 *
 *   설정: 저장소 루트의 desktop-server.env (git 에 올라가지 않는다. desktop-server.env.example 참고)
 *     RELAY_URL=wss://rabbit-ar-relay.<계정>.workers.dev
 *     DEVICE_TOKEN=<wrangler secret put DEVICE_TOKEN 에 넣은 값>
 *     LMSTUDIO_URL=http://127.0.0.1:1234        (기본값)
 *     LMSTUDIO_MODEL=gemma-4-26b-a4b-it-uncensored (기본값)
 *
 *   실행: npm run desktop-device   (또는 "토끼 서버 시작.bat")
 *
 * 답변 규칙은 폰 앱과 같다: 동작 태그는 allowlist 로만, 숫자는 포스터 자료에 있는 것만.
 * 모델이 실패하거나 자료에 없는 숫자를 쓰면 미리 준비한 답변(engine: canned)으로 바꿔 보낸다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_VERSION, LIMITS, PROTOCOL_VERSION, SCENE_ACTIONS, type DeviceChatRequest, type SceneAction } from '@rabbit/shared';
import { buildFullPrompt, filterInventedMeasurements, matchCanned, parseDesktopOutput, stripThinking, type ChatTurn } from '@rabbit/content';

export interface DesktopDeviceOptions {
  relayUrl: string;
  token: string;
  lmUrl?: string;
  model?: string;
  /** 모델 한 번 호출의 최대 시간. 릴레이의 요청 제한(170초)보다 짧아야 한다. */
  timeoutMs?: number;
  log?: boolean;
  /** 같은 토큰의 다른 서버에게 자리를 내줬을 때 */
  onReplaced?: () => void;
}

export interface DesktopDevice {
  close(): void;
  /** 처음 릴레이에 붙었을 때 끝난다. */
  ready: Promise<void>;
  stats: { answered: number; llm: number; canned: number; rejectedNumbers: number; errors: number };
}

/** 스트리밍 중 화면에 보여 줄 부분: 숨은 메모를 빼고, 동작 태그('#…') 앞까지, 마크다운 기호 제거. 문단 나눔은 살린다. */
function visibleText(raw: string): string {
  const s = stripThinking(raw);
  const cut = s.indexOf('#');
  return (cut >= 0 ? s.slice(0, cut) : s)
    .replace(/[*_`<>]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n')
    .trimStart();
}

export function startDesktopDevice(opts: DesktopDeviceOptions): DesktopDevice {
  const lmUrl = (opts.lmUrl ?? 'http://127.0.0.1:1234').replace(/\/$/, '');
  const model = opts.model ?? 'gemma-4-26b-a4b-it-uncensored';
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const log = (...a: unknown[]) => opts.log !== false && console.log(new Date().toLocaleTimeString('ko-KR', { hour12: false }), '[desktop]', ...a);
  const url = opts.relayUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/device/connect';
  const stats = { answered: 0, llm: 0, canned: 0, rejectedNumbers: 0, errors: 0 };

  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;
  /** 릴레이 연결이 바뀔 때마다 올라간다. 이전 연결에서 받은 질문을 구분하는 데 쓴다. */
  let epoch = 0;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const cancelled = new Set<string>();
  const aborters = new Map<string, AbortController>();
  /** 세션별 직전 대화 (후속 질문용). 오래된 세션부터 버린다. */
  const history = new Map<string, ChatTurn[]>();

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const send = (o: unknown) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
  };

  function connect() {
    if (closed) return;
    // Node 의 WebSocket(undici)은 두 번째 인자로 headers 를 받는다.
    const sock = new (WebSocket as any)(url, { headers: { Authorization: `Bearer ${opts.token}` } }) as WebSocket;
    ws = sock;
    sock.addEventListener('open', () => {
      sock.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, deviceVersion: CLIENT_VERSION, engine: 'lmstudio' }));
    });
    sock.addEventListener('message', (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'hello.ack') {
        backoff = 1000;
        log(`릴레이 연결됨 → ${new URL(url).host} (모델: ${model})`);
        resolveReady();
      } else if (m.type === 'cancel') {
        cancelled.add(m.requestId);
        aborters.get(m.requestId)?.abort();
      } else if (m.type === 'chat.request') {
        void enqueue(m as DeviceChatRequest);
      }
    });
    sock.addEventListener('error', () => {
      /* close 에서 처리한다 */
    });
    sock.addEventListener('close', (ev) => {
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
      // 이 연결로 받은 질문의 답은 더 보낼 곳이 없다. 만들던 답을 멈추고 대기 중인 질문도 버린다
      // (안 그러면 모델이 쓸모없는 답을 계속 만들며 다음 질문을 늦춘다).
      epoch++;
      for (const [id, a] of aborters) {
        cancelled.add(id);
        a.abort();
      }
      if (closed) return;
      if (ev.code === 4001) {
        // 같은 토큰으로 서버가 하나 더 켜졌다. 여기서 다시 붙으면 서로 연결을 빼앗으며 끝없이 끊긴다.
        closed = true;
        log('다른 창에서 토끼 서버가 켜져서 이 서버는 멈춥니다. (서버는 한 번에 하나만 켜 두세요)');
        opts.onReplaced?.();
        return;
      }
      log(`릴레이 연결 끊김 (${ev.code}${ev.code === 1006 ? ' — 주소나 토큰을 확인' : ''}). ${Math.round(backoff / 1000)}초 뒤 재접속`);
      setTimeout(connect, backoff);
      backoff = Math.min(30_000, backoff * 2);
    });
    // 유휴 연결이 끊기지 않도록 주기적으로 상태를 알린다.
    keepAlive = setInterval(() => send({ type: 'status', status: 'online', engine: 'lmstudio' }), 30_000);
  }

  // 모델은 한 번에 하나씩만 돌린다.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(req: DeviceChatRequest): Promise<void> {
    const born = epoch;
    chain = chain.then(() => (born === epoch ? answer(req) : undefined)).catch((e) => log('처리 오류', String(e)));
    return chain;
  }

  async function answer(req: DeviceChatRequest): Promise<void> {
    if (cancelled.delete(req.requestId)) return;
    const base = { requestId: req.requestId, sessionId: req.sessionId };
    const canned = matchCanned(req.message, req.topic);
    const turns = history.get(req.sessionId) ?? [];
    const prompt = buildFullPrompt(req.message, req.topic, turns);
    const t0 = Date.now();

    const sendCanned = (why: string) => {
      stats.canned++;
      log(`  → 준비된 답변으로 대체 (${why})`);
      send({ type: 'chat.final', ...base, reply: canned.reply, animation: canned.animation, highlight: canned.highlight, sourceFactIds: canned.sourceFactIds, engine: 'canned' });
    };

    log(`Q(${req.sessionId.slice(0, 8)}): ${req.message}`);
    stats.answered++;
    let raw = '';
    const ac = new AbortController();
    aborters.set(req.requestId, ac);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const call = () =>
        fetch(`${lmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: prompt.messages, stream: true, temperature: 0.6, max_tokens: 1000 }),
          signal: ac.signal,
        });
      // LM Studio 가 막 켜지는 중이거나 잠깐 끊긴 경우를 위해 한 번은 다시 시도한다.
      const res = await call().catch(async (e) => {
        if (ac.signal.aborted) throw e;
        await new Promise((r) => setTimeout(r, 1500));
        return call();
      });
      if (!res.ok || !res.body) throw new Error(`LM Studio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let sent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const piece = JSON.parse(data).choices?.[0]?.delta?.content;
            if (typeof piece === 'string') raw += piece;
          } catch {
            /* 깨진 조각은 건너뛴다 */
          }
        }
        // 보이는 부분만 조금씩 흘려보낸다 (최종 길이 제한 안에서).
        const vis = visibleText(raw).slice(0, LIMITS.maxReplyChars);
        while (vis.length > sent) {
          const part = vis.slice(sent, sent + LIMITS.maxDeltaChars);
          send({ type: 'chat.delta', ...base, text: part });
          sent += part.length;
        }
      }
    } catch (e) {
      clearTimeout(timer);
      aborters.delete(req.requestId);
      if (cancelled.delete(req.requestId)) {
        log('  → 관람객이 취소');
        return;
      }
      stats.errors++;
      return sendCanned(ac.signal.aborted ? '시간 초과' : /fetch failed/.test(String(e)) ? 'LM Studio 서버에 닿지 않음 — LM Studio 가 켜져 있는지 확인' : String(e));
    }
    clearTimeout(timer);
    aborters.delete(req.requestId);
    if (cancelled.delete(req.requestId)) return;

    const parsed = parseDesktopOutput(raw, SCENE_ACTIONS);
    // 지어낸 측정값으로 보이는 문장만 뺀다. 일반 과학 설명의 숫자는 그대로 둔다.
    const checked = filterInventedMeasurements(parsed.reply, req.message);
    if (checked.removed.length) {
      stats.rejectedNumbers++;
      log(`  (자료에 없는 측정값 문장 ${checked.removed.length}개 삭제: ${checked.removed.join(' / ').slice(0, 160)})`);
    }
    parsed.reply = checked.reply.slice(0, LIMITS.maxReplyChars);
    if (!parsed.reply) {
      stats.errors++;
      return sendCanned('빈 답변');
    }

    stats.llm++;
    // 모델은 무난한 rabbit_explain 을 고르는 경향이 있다. 질문이 특정 그래프를 가리키면 그 장면을 보여 준다.
    const picked = parsed.animation as SceneAction | null;
    const animation = (picked && picked !== 'rabbit_explain' ? picked : prompt.route?.animation) ?? picked ?? 'rabbit_explain';
    send({
      type: 'chat.final',
      ...base,
      reply: parsed.reply,
      animation,
      highlight: prompt.route?.highlight ?? null,
      sourceFactIds: prompt.factIds.slice(0, LIMITS.maxSourceFacts),
      engine: 'lmstudio',
    });
    log(`  → ${((Date.now() - t0) / 1000).toFixed(1)}초, ${parsed.reply.length}자, 동작 ${animation}`);

    history.delete(req.sessionId);
    history.set(req.sessionId, [...turns, { q: req.message, a: parsed.reply }].slice(-4));
    if (history.size > 200) history.delete(history.keys().next().value!);
  }

  connect();
  return {
    close: () => {
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      for (const a of aborters.values()) a.abort();
      ws?.close(1000, 'bye');
    },
    ready,
    stats,
  };
}

/** KEY=VALUE 줄로 된 설정 파일을 읽는다 (이미 있는 환경 변수가 우선). */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/desktop-device.ts');
if (isMain) {
  loadEnvFile(resolve(process.cwd(), 'desktop-server.env'));
  const relayUrl = process.env.RELAY_URL;
  const token = process.env.DEVICE_TOKEN;
  const lmUrl = (process.env.LMSTUDIO_URL ?? 'http://127.0.0.1:1234').replace(/\/$/, '');
  const model = process.env.LMSTUDIO_MODEL ?? 'gemma-4-26b-a4b-it-uncensored';
  if (!relayUrl || !token) {
    console.error('desktop-server.env 에 RELAY_URL 과 DEVICE_TOKEN 을 적어 주세요 (desktop-server.env.example 참고).');
    process.exit(1);
  }
  try {
    const r = await fetch(`${lmUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
    const ids: string[] = ((await r.json()) as any).data?.map((d: any) => d.id) ?? [];
    if (!ids.includes(model)) console.warn(`경고: LM Studio 에 '${model}' 모델이 보이지 않습니다. 보이는 모델: ${ids.join(', ') || '(없음)'}`);
  } catch {
    console.warn(`경고: LM Studio 서버(${lmUrl})에 닿지 않습니다. 켜질 때까지는 준비된 답변으로만 응답합니다.`);
  }
  // 긴 시스템 프롬프트를 미리 한 번 읽혀 둔다. 안 하면 첫 관람객이 30초쯤 기다린다.
  try {
    const t0 = Date.now();
    await fetch(`${lmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: buildFullPrompt('안녕').messages, max_tokens: 1, temperature: 0 }),
      signal: AbortSignal.timeout(180_000),
    });
    console.log(`모델 예열 완료 (${((Date.now() - t0) / 1000).toFixed(0)}초)`);
  } catch {
    console.warn('경고: 모델 예열에 실패했습니다. 첫 답변이 느릴 수 있습니다.');
  }
  startDesktopDevice({ relayUrl, token, lmUrl, model, onReplaced: () => process.exit(0) });
}
