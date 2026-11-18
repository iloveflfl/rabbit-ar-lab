/**
 * 데스크탑 단말. 폰 앱 대신 이 PC 가 릴레이에 붙어서 LM Studio 의 로컬 모델(Gemma 4)로 답한다.
 * PC 는 바깥으로 접속만 하므로 포트를 열 필요가 없고, 관람객이 보는 주소는 릴레이(workers.dev)로 고정된다.
 *
 *   설정: 저장소 루트의 desktop-server.env (git 에 올라가지 않는다. desktop-server.env.example 참고)
 *     RELAY_URL=wss://rabbit-ar-relay.<계정>.workers.dev
 *     DEVICE_TOKEN=<wrangler secret put DEVICE_TOKEN 에 넣은 값>
 *     LMSTUDIO_URL=http://127.0.0.1:1234        (기본값)
 *     LMSTUDIO_MODEL=gemma-4-26b-a4b-it-uncensored (기본값)
 *     LMSTUDIO_CONTEXT=16384                    (기본값. 모델을 다시 올릴 때 쓰는 문맥 길이)
 *     KEEP_AWAKE=0                              (PC 절전 방지를 끄려면)
 *
 *   실행: npm run desktop-device   (또는 "토끼 서버 시작.bat")
 *
 * 답변 규칙: 동작 태그는 allowlist 로만, 이 실험의 측정값은 포스터 자료에 있는 것만.
 * 모델이 실패하면 미리 준비한 답변(engine: canned)으로 바꿔 보낸다.
 *
 * 안정성 (전시 내내 사람 손 없이 버티는 것이 목표):
 *   - 릴레이: 접속 시간 제한, 20초마다 ping, 50초 동안 응답이 없으면 죽은 연결로 보고 다시 붙는다.
 *     끊기면 만들던 답을 멈추고 지수 백오프로 재접속한다. 계속 실패하면 원인(토큰/네트워크)을 알려 준다.
 *   - LM Studio: 30초마다 상태를 본다. 서버가 꺼졌거나 모델이 내려갔으면 `lms` 로 다시 켜고 올리고 예열한다.
 *   - 모델 호출: 전체 150초, 첫 글자 70초, 글자 사이 45초 제한. 걸리면 준비된 답변으로 넘어간다.
 *   - 프로세스: 처리되지 않은 예외로 죽지 않는다. 기록은 logs/ 에도 남긴다.
 *
 * 종료 코드: 0 = 다른 서버에게 자리를 내주고 멈춤 / 2 = 설정 오류 (bat 이 다시 켜지 않는다). 그 밖은 bat 이 다시 켠다.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  /** 첫 글자가 나올 때까지의 최대 시간 */
  firstTokenMs?: number;
  /** 스트리밍 도중 글자 사이의 최대 공백 */
  idleMs?: number;
  log?: boolean;
  /** 기록을 남길 파일 (없으면 화면에만) */
  logFile?: string;
  /** 같은 토큰의 다른 서버에게 자리를 내줬을 때 */
  onReplaced?: () => void;
  /** 모델 호출이 실패했을 때 (LM Studio 점검을 앞당기는 데 쓴다) */
  onModelFailure?: () => void;
  /** 모델이 지금 답할 수 있는 상태인지. false 면 모델을 부르지 않고 바로 준비된 답변을 보낸다. */
  modelReady?: () => boolean;
}

export interface DesktopDevice {
  close(): void;
  /** 처음 릴레이에 붙었을 때 끝난다. */
  ready: Promise<void>;
  stats: { answered: number; llm: number; canned: number; rejectedNumbers: number; errors: number; reconnects: number };
  connected(): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 화면과 파일에 같이 남기는 기록기. 파일 쓰기 실패는 무시한다(기록 때문에 서버가 죽으면 안 된다). */
export function makeLogger(enabled: boolean, file?: string) {
  return (...a: unknown[]) => {
    const line = `${new Date().toLocaleTimeString('ko-KR', { hour12: false })} [desktop] ${a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')}`;
    if (enabled) console.log(line);
    if (file) {
      try {
        appendFileSync(file, `${new Date().toISOString().slice(0, 10)} ${line}\n`);
      } catch {
        /* 무시 */
      }
    }
  };
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
  const firstTokenMs = opts.firstTokenMs ?? 70_000;
  const idleMs = opts.idleMs ?? 45_000;
  const log = makeLogger(opts.log !== false, opts.logFile);
  const url = opts.relayUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/device/connect';
  const statusUrl = url.replace(/^ws/, 'http').replace(/\/device\/connect$/, '/device/status');
  const stats = { answered: 0, llm: 0, canned: 0, rejectedNumbers: 0, errors: 0, reconnects: 0 };

  let ws: WebSocket | null = null;
  let online = false;
  let closed = false;
  let backoff = 1000;
  let failures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 릴레이 연결이 바뀔 때마다 올라간다. 이전 연결에서 받은 질문을 구분하는 데 쓴다. */
  let epoch = 0;
  const cancelled = new Set<string>();
  const aborters = new Map<string, AbortController>();
  /** 세션별 직전 대화 (후속 질문용). 오래된 세션부터 버린다. */
  const history = new Map<string, ChatTurn[]>();

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const send = (o: unknown) => {
    try {
      if (ws && ws.readyState === ws.OPEN) ws.send(typeof o === 'string' ? o : JSON.stringify(o));
    } catch {
      /* 보내는 순간 끊긴 경우. close 처리에서 정리된다. */
    }
  };

  function scheduleReconnect(delay: number) {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  /** 접속이 계속 실패할 때 원인을 알려 준다 (토큰이 틀렸는지, 네트워크가 안 되는지). */
  async function diagnose(): Promise<void> {
    try {
      const r = await fetch(statusUrl, { headers: { Authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(8000) });
      if (r.status === 401) log('!! 릴레이가 토큰을 거부합니다. desktop-server.env 의 DEVICE_TOKEN 이 릴레이에 등록한 값과 같은지 확인하세요.');
      else if (r.status === 503) log('!! 릴레이에 DEVICE_TOKEN 이 등록돼 있지 않습니다 (npx wrangler secret put DEVICE_TOKEN).');
      else if (!r.ok) log(`!! 릴레이가 ${r.status} 로 답합니다. 주소(RELAY_URL)를 확인하세요.`);
      else log('릴레이 주소와 토큰은 정상입니다. 웹소켓 연결만 실패하고 있습니다 (방화벽·프록시 가능성).');
    } catch {
      log('!! 릴레이에 닿지 않습니다. 이 PC 의 인터넷 연결을 확인하세요. 계속 다시 시도합니다.');
    }
  }

  function connect() {
    if (closed) return;
    let sock: WebSocket;
    try {
      // Node 의 WebSocket(undici)은 두 번째 인자로 headers 를 받는다.
      sock = new (WebSocket as any)(url, { headers: { Authorization: `Bearer ${opts.token}` } }) as WebSocket;
    } catch (e) {
      log('릴레이 접속을 시작하지 못했습니다:', String(e));
      scheduleReconnect(backoff);
      backoff = Math.min(30_000, backoff * 2);
      return;
    }
    ws = sock;
    let dead = false;
    let acked = false;
    let lastRx = Date.now();
    let ping: ReturnType<typeof setInterval> | null = null;

    /** 이 소켓을 정리한다. close 이벤트가 오든, 우리가 죽었다고 판단하든 한 번만 실행된다. */
    const teardown = (code: number, why: string) => {
      if (dead) return;
      dead = true;
      clearTimeout(openTimer);
      if (ping) clearInterval(ping);
      if (ws === sock) {
        ws = null;
        online = false;
      }
      try {
        sock.close();
      } catch {
        /* 이미 닫힘 */
      }
      // 이 연결로 받은 질문의 답은 더 보낼 곳이 없다. 만들던 답을 멈추고 대기 중인 질문도 버린다
      // (안 그러면 모델이 쓸모없는 답을 계속 만들며 다음 질문을 늦춘다).
      epoch++;
      for (const [id, a] of aborters) {
        cancelled.add(id);
        a.abort();
      }
      if (closed) return;

      if (code === 4001) {
        // 릴레이가 "다른 서버로 바뀌었다"며 끊었다. 정말 다른 서버가 붙어 있는지 확인한 뒤에만 멈춘다.
        void (async () => {
          await sleep(2500);
          let other = false;
          try {
            const r = await fetch(statusUrl, { headers: { Authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(8000) });
            const st = ((await r.json()) as { status?: string }).status;
            other = st === 'online' || st === 'busy';
          } catch {
            /* 확인하지 못하면 다시 붙어 본다 */
          }
          if (closed) return;
          if (other) {
            // 같은 토큰으로 서버가 하나 더 켜져 있다. 여기서 다시 붙으면 서로 연결을 빼앗으며 끝없이 끊긴다.
            closed = true;
            log('다른 창에서 토끼 서버가 켜져 있어서 이 서버는 멈춥니다. (서버는 한 번에 하나만 켜 두세요)');
            opts.onReplaced?.();
          } else {
            log('릴레이가 연결을 정리했습니다. 다시 붙습니다.');
            connect();
          }
        })();
        return;
      }

      if (acked) {
        failures = 0;
        backoff = 1000;
      } else {
        failures++;
        if (failures === 3 || failures % 20 === 0) void diagnose();
      }
      stats.reconnects++;
      const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
      log(`릴레이 연결 끊김 (${why}). ${(delay / 1000).toFixed(1)}초 뒤 재접속`);
      scheduleReconnect(delay);
      backoff = Math.min(30_000, backoff * 2);
    };

    // 접속 자체가 멈춰 버리는 경우(응답 없는 네트워크)
    const openTimer = setTimeout(() => !acked && teardown(0, '접속 시간 초과'), 15_000);

    sock.addEventListener('open', () => {
      lastRx = Date.now();
      send({ type: 'hello', protocol: PROTOCOL_VERSION, deviceVersion: CLIENT_VERSION, engine: 'lmstudio' });
      // ping 은 릴레이가 잠든 채로 바로 답한다. 답이 끊기면 겉보기엔 열려 있어도 죽은 연결이다
      // (PC 가 절전에서 깨어났거나 공유기가 연결을 조용히 버린 경우).
      ping = setInterval(() => {
        if (Date.now() - lastRx > 50_000) return teardown(0, '응답 없음');
        send('{"type":"ping"}');
      }, 20_000);
    });
    sock.addEventListener('message', (ev) => {
      lastRx = Date.now();
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hello.ack') {
        acked = true;
        online = true;
        clearTimeout(openTimer);
        log(`릴레이 연결됨 → ${new URL(url).host} (모델: ${model})`);
        resolveReady();
      } else if (m.type === 'cancel' && typeof m.requestId === 'string') {
        cancelled.add(m.requestId);
        if (cancelled.size > 500) cancelled.delete(cancelled.values().next().value!);
        aborters.get(m.requestId)?.abort();
      } else if (m.type === 'chat.request' && typeof m.requestId === 'string' && typeof m.sessionId === 'string' && typeof m.message === 'string') {
        void enqueue(m as DeviceChatRequest);
      }
    });
    sock.addEventListener('error', () => {
      /* close 에서 처리한다 */
    });
    sock.addEventListener('close', (ev) => teardown(ev.code, `코드 ${ev.code}`));
  }

  // 모델은 한 번에 하나씩만 돌린다.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(req: DeviceChatRequest): Promise<void> {
    const born = epoch;
    chain = chain
      .then(() => (born === epoch ? answer(req) : undefined))
      .catch((e) => {
        stats.errors++;
        log('질문 처리 중 오류 (서버는 계속 돕니다):', e instanceof Error ? (e.stack ?? e.message) : String(e));
      });
    return chain;
  }

  async function answer(req: DeviceChatRequest): Promise<void> {
    if (cancelled.delete(req.requestId)) return;
    // 줄 서 있는 동안 릴레이의 제한 시간이 지나 버린 질문은 답해도 받을 사람이 없다.
    if (typeof req.timestamp === 'number' && Date.now() - req.timestamp > LIMITS.requestTimeoutMs - 5000) {
      log(`Q(${req.sessionId.slice(0, 8)}) 너무 오래 기다린 질문이라 건너뜀`);
      return;
    }
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
    // 모델을 다시 올리거나 예열하는 중에 질문을 밀어 넣으면 둘 다 느려진다. 그동안은 준비된 답변으로 바로 답한다.
    if (opts.modelReady && !opts.modelReady()) return sendCanned('모델 준비 중');
    let raw = '';
    let abortWhy = '';
    const ac = new AbortController();
    aborters.set(req.requestId, ac);
    const abort = (why: string) => {
      abortWhy ||= why;
      ac.abort();
    };
    const total = setTimeout(() => abort('전체 시간 초과'), timeoutMs);
    // 글자가 나오다 멈추는 경우(모델이 멎음)를 전체 시간 초과보다 먼저 잡는다.
    let stall = setTimeout(() => abort('첫 글자가 나오지 않음'), firstTokenMs);
    const kick = () => {
      clearTimeout(stall);
      stall = setTimeout(() => abort('글자가 나오다 멈춤'), idleMs);
    };
    const cleanup = () => {
      clearTimeout(total);
      clearTimeout(stall);
      aborters.delete(req.requestId);
    };

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
        await sleep(1500);
        return call();
      });
      if (!res.ok || !res.body) throw new Error(`LM Studio HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

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
            const j = JSON.parse(data);
            if (j.error) throw new Error(`LM Studio: ${JSON.stringify(j.error).slice(0, 200)}`);
            const piece = j.choices?.[0]?.delta?.content;
            if (typeof piece === 'string' && piece) {
              raw += piece;
              kick();
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('LM Studio:')) throw e;
            /* 깨진 조각은 건너뛴다 */
          }
        }
        // 폭주 방지: 한도를 한참 넘도록 쓰고 있으면 끊는다.
        if (raw.length > LIMITS.maxReplyChars * 3) {
          void reader.cancel().catch(() => {});
          break;
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
      cleanup();
      if (cancelled.delete(req.requestId)) {
        log('  → 취소됨 (관람객이 취소했거나 릴레이 연결이 끊김)');
        return;
      }
      stats.errors++;
      opts.onModelFailure?.();
      const why = abortWhy || (/fetch failed|ECONNREFUSED|ECONNRESET|terminated/.test(String(e)) ? 'LM Studio 서버에 닿지 않음' : String(e).slice(0, 200));
      return sendCanned(why);
    }
    cleanup();
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
      log(`  (모델 출력을 답으로 쓸 수 없음: ${JSON.stringify(raw.slice(0, 160))})`);
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const a of aborters.values()) a.abort();
      try {
        ws?.close(1000, 'bye');
      } catch {
        /* 이미 닫힘 */
      }
    },
    ready,
    stats,
    connected: () => online,
  };
}

/* ───────────── LM Studio 감시·자가 복구 ───────────── */

interface LmHealth {
  server: boolean;
  loaded: boolean;
  context: number;
  known: boolean;
}

async function lmHealth(lmUrl: string, model: string): Promise<LmHealth> {
  try {
    const r = await fetch(`${lmUrl}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
    const data: any[] = ((await r.json()) as any).data ?? [];
    const m = data.find((d) => d.id === model);
    return { server: true, known: !!m, loaded: m?.state === 'loaded', context: Number(m?.loaded_context_length ?? 0) };
  } catch {
    return { server: false, known: false, loaded: false, context: 0 };
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        // 진행 표시(스피너)와 색 코드를 걷어 내고 마지막 줄만 남긴다.
        const out = `${stdout ?? ''}${stderr ?? ''}`
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .split(/[\r\n]+/)
          .map((l) => l.replace(/[\u2800-\u28ff]/g, '').trim())
          .filter(Boolean)
          .slice(-2)
          .join(' / ');
        res({ ok: !err, out: out.slice(-300) });
      });
    } catch (e) {
      res({ ok: false, out: String(e) });
    }
  });
}

/**
 * LM Studio 를 주기적으로 살핀다. 서버가 꺼졌거나 모델이 내려갔거나 문맥 길이가 모자라게 올라와 있으면
 * `lms` 명령으로 바로잡고 예열한다. 고치는 동안에도 서버는 준비된 답변으로 계속 응답한다.
 */
export function startLmGuard(o: { lmUrl: string; model: string; context: number; log: (...a: unknown[]) => void }) {
  const minContext = Math.min(o.context, 12_000);
  let busy = false;
  /** 모델이 올라와 있고 예열까지 끝났는가 */
  let lastOk = false;
  let lastFixAt = 0;
  let stopped = false;

  const warm = async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${o.lmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: o.model, messages: buildFullPrompt('안녕').messages, max_tokens: 1, temperature: 0 }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      o.log(`모델 예열 완료 (${((Date.now() - t0) / 1000).toFixed(0)}초)`);
      return true;
    } catch (e) {
      o.log('!! 모델 예열 실패:', String(e).slice(0, 160));
      return false;
    }
  };

  const check = async (reason: string): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      let h = await lmHealth(o.lmUrl, o.model);
      const healthy = h.server && h.loaded && h.context >= minContext;
      if (healthy) {
        // 올라와 있지만 아직 예열하지 않았으면(시작 직후, 누가 직접 다시 올린 경우) 예열부터 한다.
        if (!lastOk) lastOk = await warm();
        return;
      }
      lastOk = false;
      // 너무 자주 고치려 들지 않는다 (모델을 올리는 데 30초쯤 걸린다).
      if (Date.now() - lastFixAt < 45_000) return;
      lastFixAt = Date.now();

      if (!h.server) {
        o.log(`!! LM Studio 서버가 응답하지 않습니다 (${reason}). 다시 켭니다…`);
        const r = await run('lms', ['server', 'start'], 60_000);
        if (!r.ok) o.log('!! lms server start 실패:', r.out || 'lms 명령을 찾지 못했습니다');
        for (let i = 0; i < 15 && !(h = await lmHealth(o.lmUrl, o.model)).server; i++) await sleep(2000);
        if (!h.server) {
          o.log('!! LM Studio 서버를 켜지 못했습니다. LM Studio 를 직접 열어 주세요. 그동안은 준비된 답변으로 응답합니다.');
          return;
        }
      }
      if (!h.known) {
        o.log(`!! LM Studio 에 '${o.model}' 모델이 없습니다. desktop-server.env 의 LMSTUDIO_MODEL 을 확인하세요.`);
        return;
      }
      if (h.loaded && h.context < minContext) {
        o.log(`!! 모델의 문맥 길이가 ${h.context} 로 너무 짧게 올라와 있습니다. 다시 올립니다…`);
        await run('lms', ['unload', o.model], 60_000);
      } else if (!h.loaded) {
        o.log(`!! 모델이 내려가 있습니다 (${reason}). 다시 올립니다…`);
      }
      const r = await run('lms', ['load', o.model, '--context-length', String(o.context), '--gpu', 'max', '-y'], 300_000);
      h = await lmHealth(o.lmUrl, o.model);
      if (!h.loaded) {
        o.log('!! 모델을 올리지 못했습니다:', r.out || '(출력 없음)', '— GPU 메모리를 쓰는 다른 프로그램이 있는지 확인하세요. 곧 다시 시도합니다.');
        lastFixAt = Date.now() - 30_000; // 다음 점검(30초 뒤)에서 바로 다시 시도한다
        return;
      }
      o.log(`모델 다시 올림 (문맥 ${h.context})`);
      lastOk = await warm();
    } catch (e) {
      o.log('LM Studio 점검 중 오류:', String(e).slice(0, 200));
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void check('정기 점검'), 30_000);
  return {
    check,
    ready: () => lastOk,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** 서버가 켜져 있는 동안 PC 가 절전에 들어가지 않게 한다 (설정을 바꾸지 않고, 이 프로세스가 사는 동안만 요청한다). */
function keepAwake(log: (...a: unknown[]) => void): ChildProcess | null {
  if (process.platform !== 'win32' || process.env.KEEP_AWAKE === '0') return null;
  try {
    const script =
      "$s='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
      "$t=Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru;" +
      'while($true){[void]$t::SetThreadExecutionState(0x80000001);Start-Sleep -Seconds 30}';
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => log('절전 방지를 켜지 못했습니다. PC 가 절전에 들어가지 않게 직접 설정해 주세요.'));
    return child;
  } catch {
    return null;
  }
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
  let logFile: string | undefined;
  try {
    mkdirSync(resolve(process.cwd(), 'logs'), { recursive: true });
    logFile = resolve(process.cwd(), 'logs', `desktop-server-${new Date().toISOString().slice(0, 10)}.log`);
  } catch {
    /* 기록 폴더를 못 만들어도 서버는 돈다 */
  }
  const log = makeLogger(true, logFile);

  // 어떤 예외가 새어 나와도 서버가 죽지 않게 한다. 전시 중에 창이 꺼지는 것이 가장 나쁜 고장이다.
  process.on('unhandledRejection', (e) => log('처리되지 않은 오류 (계속 실행):', e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.on('uncaughtException', (e) => log('예상치 못한 오류 (계속 실행):', e.stack ?? e.message));

  const relayUrl = process.env.RELAY_URL?.trim();
  const token = process.env.DEVICE_TOKEN?.trim();
  const lmUrl = (process.env.LMSTUDIO_URL ?? 'http://127.0.0.1:1234').trim().replace(/\/$/, '');
  const model = (process.env.LMSTUDIO_MODEL ?? 'gemma-4-26b-a4b-it-uncensored').trim();
  const context = Number(process.env.LMSTUDIO_CONTEXT) > 0 ? Number(process.env.LMSTUDIO_CONTEXT) : 16384;
  if (!relayUrl || !token || !/^(wss?|https?):\/\//.test(relayUrl)) {
    log('!! desktop-server.env 에 RELAY_URL(wss://…) 과 DEVICE_TOKEN 을 적어 주세요 (desktop-server.env.example 참고).');
    process.exit(2);
  }

  log(`토끼 서버 시작 — 릴레이 ${new URL(relayUrl.replace(/^ws/, 'http')).host}, 모델 ${model}${logFile ? `, 기록 ${logFile}` : ''}`);
  const awake = keepAwake(log);
  const guard = startLmGuard({ lmUrl, model, context, log });
  // 시작할 때 LM Studio 를 점검하고(꺼져 있으면 켠다), 긴 시스템 프롬프트를 미리 읽혀 둔다.
  await guard.check('시작');

  const dev = startDesktopDevice({
    relayUrl,
    token,
    lmUrl,
    model,
    logFile,
    onModelFailure: () => void guard.check('모델 호출 실패'),
    modelReady: () => guard.ready(),
    onReplaced: () => {
      guard.stop();
      awake?.kill();
      process.exit(0);
    },
  });

  // 10분마다 요약을 남긴다 (창을 봤을 때 살아 있는지 알 수 있게).
  setInterval(() => {
    const s = dev.stats;
    log(`상태: 릴레이 ${dev.connected() ? '연결됨' : '끊김(재접속 중)'} · 질문 ${s.answered} (모델 ${s.llm}, 준비된 답변 ${s.canned}) · 오류 ${s.errors} · 재접속 ${s.reconnects}`);
  }, 600_000);

  const shutdown = () => {
    log('토끼 서버를 끕니다.');
    guard.stop();
    awake?.kill();
    dev.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
