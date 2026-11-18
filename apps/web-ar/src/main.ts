import '@fontsource/jua';
import './styles.css';
import type { HighlightId, TopicId } from '@rabbit/shared';
import { sceneScripts, scenes } from '@rabbit/content';
import { CameraError, type TrackState, xrSupported } from './ar/support';
import type { ArView } from './ar/tracker';
import { ViewerView } from './ar/viewer';
import { ChatController } from './chat/chatController';
import { RabbitCanvas } from './rabbit/rabbitSprite';
import { LabStage, type Quality, type SceneEvent } from './stage/stage';
import { ChatPanel } from './ui/chatPanel';
import { h } from './ui/dom';

const DEV = import.meta.env.DEV;
const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;

/** 릴레이 주소는 빌드할 때 VITE_RELAY_URL 로 넣는다(공개 정보). 개발 중에는 ?relay= 로 바꿔 볼 수 있다. */
const relayUrl: string | null = (DEV && params.get('relay')) || import.meta.env.VITE_RELAY_URL || null;
const chat = new ChatController(relayUrl);
chat.connect();

/** 추적 엔진은 용량이 커서 따로 내려받는다. 랜딩이 뜨면 미리 받아 두어 버튼을 누른 뒤 기다리지 않게 한다. */
let arModules: Promise<[typeof import('./ar/tracker'), typeof import('./ar/xrView')]> | null = null;
const loadAr = () => (arModules ??= Promise.all([import('./ar/tracker'), import('./ar/xrView')]));

function detectQuality(): Quality {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (params.get('q') === 'low') return 'low';
  if ((nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 3) return 'low';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'low';
  return 'high';
}

/* ───────────────────────── 랜딩 ───────────────────────── */

let landingRaf = 0;

function showLanding(error?: string): void {
  cancelAnimationFrame(landingRaf);
  const art = new RabbitCanvas(1);
  art.canvas.className = 'land-rabbit';
  art.animator.play('rabbit_wave');
  let last = performance.now();
  let nextWave = 5;
  const tick = (now: number) => {
    landingRaf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    nextWave -= dt;
    if (nextWave <= 0) {
      art.animator.play(Math.random() < 0.5 ? 'rabbit_wave' : 'rabbit_cheer');
      nextWave = 6;
    }
    art.draw(dt);
  };
  landingRaf = requestAnimationFrame(tick);

  const status = h('p', { class: 'land-note' });
  const renderStatus = () => {
    const s = chat.linkStatus;
    status.replaceChildren(
      h('span', { class: `dot ${s === 'online' ? 'online' : s === 'busy' ? 'busy' : ''}` }),
      s === 'online' || s === 'busy' ? '토끼 채팅 서버 온라인 — 전시자 폰의 AI가 질문에 답해요' : '토끼 채팅 서버 오프라인 — 미리 준비한 답변으로 체험할 수 있어요',
    );
  };
  renderStatus();
  chat.onStatus = renderStatus;

  const arBtn = h('button', { class: 'btn btn-primary', type: 'button', text: 'AR 시작하기', onclick: () => void startAr('device') });
  const insecure = !window.isSecureContext;
  const landing = h(
    'section',
    { id: 'landing' },
    h(
      'div',
      { class: 'land' },
      h('span', { class: 'land-tag', text: '쉬운 과학 교실' }),
      art.canvas,
      h('h1', {}, '토끼 연구실', h('small', { text: '포스터가 살아 움직인다' })),
      h('p', { class: 'lead', text: '벽에 걸린 학술 포스터를 비추면, 토끼 선생님이 나타나 극저온 식각 실험을 쉽게 알려 줘요.' }),
      error ? h('div', { class: 'land-error', role: 'alert', text: error }) : null,
      arBtn,
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'AR 없이 2D로 보기', onclick: () => void startViewer() }),
      DEV ? h('button', { class: 'btn btn-ghost', type: 'button', text: '[개발] 모의 카메라로 AR 시험', onclick: () => void startAr('sim') }) : null,
      h(
        'ul',
        { class: 'steps' },
        h('li', {}, h('b', { text: '1' }), '카메라를 허용해요'),
        h('li', {}, h('b', { text: '2' }), '포스터 전체를 비춰요'),
        h('li', {}, h('b', { text: '3' }), '아래 채팅으로 물어봐요'),
      ),
      status,
      h('p', {
        class: 'land-note',
        text: insecure ? '이 주소는 HTTPS 가 아니라서 카메라를 쓸 수 없어요. 2D로 보기를 이용해 주세요.' : '카메라 영상은 이 기기 안에서만 쓰이고 어디로도 전송되지 않아요. 포스터가 안 잡히면 조금 뒤로 물러나 밝은 곳에서 비춰 주세요.',
      }),
    ),
  );
  if (insecure) arBtn.setAttribute('disabled', '');
  app.replaceChildren(landing);
  window.setTimeout(() => void loadAr().catch(() => (arModules = null)), 400);
}

/* ───────────────────────── 체험 화면 ───────────────────────── */

interface Session {
  stage: LabStage;
  stop(): void;
}
let session: Session | null = null;

/** 배포본 구분용 (진단 상자에 표시) */
const BUILD = '1119f';

function buildExperience(mode: 'ar' | 'viewer', simulated: boolean) {
  const debugBox = params.get('debug') ? h('pre', { class: 'debug-box' }) : null;
  cancelAnimationFrame(landingRaf);
  const stage = new LabStage(detectQuality());
  const view = h('div', { id: 'view' });
  const statusPill = h('div', { class: 'pill status', 'data-s': mode === 'viewer' ? 'viewer' : 'starting', role: 'status' });
  const toggle = h('button', { class: 'pill toggle', type: 'button', 'aria-pressed': 'false', text: '원본 보기' });
  const scan = h('div', { class: `scan${mode === 'viewer' ? ' off' : ''}` }, h('div', { class: 'scan-frame' }, h('div', { class: 'scan-text' }, '포스터 전체를 네모 안에 맞춰 주세요', h('small', { text: '1 m 쯤 떨어져서, 반사가 없는 각도로' }))));

  /* 자막(토끼 대사) */
  const capTitle = h('div', { class: 'caption-title' });
  const capStep = h('span', { class: 'caption-step' });
  const capText = h('p', { class: 'caption-text' });
  const prev = h('button', { type: 'button', 'aria-label': '이전 장면', text: '◀', onclick: () => stage.prev() });
  const next = h('button', { type: 'button', 'aria-label': '다음 장면', text: '▶', onclick: () => stage.next() });
  const caption = h('div', { class: 'caption', hidden: true }, h('div', { class: 'caption-head' }, capTitle, capStep, h('div', { class: 'nav' }, prev, next)), capText);

  // 자막이 포스터를 가릴 때: 제목을 누르면 대사를 접었다 펼 수 있다.
  const fold = h('button', { type: 'button', 'aria-label': '설명 접기/펴기', text: '▾' });
  fold.addEventListener('click', () => {
    const min = caption.classList.toggle('min');
    fold.textContent = min ? '▴' : '▾';
  });
  caption.querySelector('.nav')!.prepend(fold);

  const chipEls = sceneScripts.map((s) => h('button', { class: 'chip', type: 'button', text: s.chip, onclick: () => stage.goScene(s.id) }));
  const chips = h('nav', { class: 'chips', 'aria-label': '장면 고르기', hidden: true }, ...chipEls);

  let currentTopic: TopicId = 'general';
  let currentPanel: HighlightId | null = null;
  let typing = false;
  const setTyping = (on: boolean) => {
    typing = on;
    kbSeen = false;
    if (touch) root.classList.toggle('typing', on);
  };
  const panel = new ChatPanel(chat, {
    context: () => ({ topic: currentTopic, panel: currentPanel }),
    onThinking: (on) => stage.setThinking(on),
    onTalking: (on) => stage.setTalking(on),
    onAnswer: (a) => stage.runAction(a.animation, a.highlight),
    onStateChange: (s) => {
      caption.style.display = s === 'idle' ? '' : 'none';
      chips.style.display = s === 'open' ? 'none' : '';
    },
    onTyping: (on) => setTyping(on),
  });

  /* 자막 타이핑 */
  let typeTimer = 0;
  const typeLines = (lines: string[]) => {
    clearInterval(typeTimer);
    const full = lines.join(' ');
    let i = 0;
    capText.textContent = '';
    stage.setTalking(true);
    typeTimer = window.setInterval(() => {
      i = Math.min(full.length, i + 2);
      capText.textContent = full.slice(0, i);
      if (i >= full.length) {
        clearInterval(typeTimer);
        stage.setTalking(false);
      }
    }, 34);
  };

  stage.onScene = (e: SceneEvent) => {
    currentTopic = sceneScripts[e.index].topic;
    currentPanel = e.highlight;
    chipEls.forEach((c, i) => c.setAttribute('aria-current', String(i === e.index)));
    // scrollIntoView 는 화면 전체까지 밀 수 있다(키보드가 떠 있을 때 화면이 튄다). 칩 줄 안에서만 움직인다.
    const chip = chipEls[e.index];
    chips.scrollTo({ left: chip.offsetLeft - (chips.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
    caption.hidden = false;
    chips.hidden = false;
    capTitle.textContent = e.title;
    capStep.textContent = `${e.index + 1} / ${e.total}`;
    prev.disabled = e.index === 0;
    next.disabled = e.index === e.total - 1;
    if (e.silent) {
      clearInterval(typeTimer);
      capText.textContent = e.lines.join(' ');
    } else typeLines(e.lines);
  };

  toggle.addEventListener('click', () => {
    const toOriginal = stage.viewMode === 'rabbit';
    stage.setMode(toOriginal ? 'original' : 'rabbit');
    toggle.setAttribute('aria-pressed', String(toOriginal));
    toggle.textContent = toOriginal ? '토끼 포스터' : '원본 보기';
  });

  const exit = h('button', { class: 'pill icon', type: 'button', 'aria-label': '처음으로', text: '✕', onclick: () => leave() });
  const bottom = h('div', { id: 'bottom' }, caption, chips, panel.el);
  const root = h(
    'section',
    { id: 'xp', class: mode },
    view,
    scan,
    h(
      'header',
      { class: 'hud' },
      exit,
      statusPill,
      mode === 'ar' ? toggle : h('span', { style: 'width:40px' }),
    ),
    simulated ? h('div', { class: 'sim-badge', text: '모의 카메라 (개발용) — 실기기 검증 아님' }) : null,
    debugBox,
    bottom,
  );
  app.replaceChildren(root);

  // 화면 키보드: 키보드 높이를 재서 입력창을 그 위에 맞추는 방식은 폰마다(특히 AR 전체화면에서) 값이 흔들려
  // 입력창이 깜빡였다. 그래서 터치 기기에서는 입력하는 동안 채팅을 화면 "위쪽"에 고정한다.
  // 키보드는 아래에서 올라오므로 위쪽은 항상 보이고, 키보드 높이를 알 필요가 없다.
  const vv = window.visualViewport;
  const touch = window.matchMedia('(pointer: coarse)').matches;
  let kbSeen = false;
  const onViewport = () => {
    if (!typing || !vv) return;
    const open = vv.height < window.innerHeight * 0.8;
    if (open) kbSeen = true;
    else if (kbSeen) panel.blurInput(); // 뒤로가기로 키보드만 내린 경우: 입력 상태도 끝낸다
  };
  vv?.addEventListener('resize', onViewport);
  view.addEventListener('pointerdown', () => typing && panel.blurInput());
  // 전체화면(AR)에서는 키보드가 뜨거나 추천 줄 높이가 바뀔 때마다 브라우저가 화면 크기를 다시 잡아서
  // 입력창이 깜빡였다. 키보드가 화면 크기를 건드리지 않고 그냥 위에 덮이게 한다(입력창은 위쪽에 고정돼 있어 가려지지 않는다).
  const vk = (navigator as Navigator & { virtualKeyboard?: EventTarget & { overlaysContent: boolean; boundingRect: DOMRect } }).virtualKeyboard;
  const onVk = () => {
    if (!typing || !vk) return;
    if (vk.boundingRect.height > 0) kbSeen = true;
    else if (kbSeen) panel.blurInput();
  };
  if (vk) {
    vk.overlaysContent = true;
    vk.addEventListener('geometrychange', onVk);
  }

  const setStatus = (s: TrackState | 'viewer') => {
    statusPill.dataset.s = s;
    statusPill.textContent =
      s === 'starting' ? '카메라를 준비하는 중…' : s === 'searching' ? '포스터를 찾는 중…' : s === 'tracking' ? '포스터 인식됨' : s === 'lost' ? '포스터를 놓쳤어요 · 다시 비춰 주세요' : '2D 보기 · 화면을 끌어 보세요';
    scan.classList.toggle('off', s === 'tracking' || s === 'viewer');
  };
  setStatus(mode === 'viewer' ? 'viewer' : 'starting');

  const cleanup: Array<() => void> = [
    () => clearInterval(typeTimer),
    () => vv?.removeEventListener('resize', onViewport),
    () => vk?.removeEventListener('geometrychange', onVk),
  ];
  // 진단(?debug=1): 입력 중 무엇이 흔들리는지 센다. 입력창이 깜빡일 때 어떤 숫자가 올라가는지로 원인을 가린다.
  const d = { focus: 0, blur: 0, vvR: 0, vvS: 0, winR: 0, mut: 0, fs: 0, vis: 0 };
  if (debugBox) {
    root.addEventListener('focusin', () => d.focus++);
    root.addEventListener('focusout', () => d.blur++);
    const onR = () => d.vvR++;
    const onS = () => d.vvS++;
    const onW = () => d.winR++;
    const onF = () => d.fs++;
    const onV = () => d.vis++;
    vv?.addEventListener('resize', onR);
    vv?.addEventListener('scroll', onS);
    window.addEventListener('resize', onW);
    document.addEventListener('fullscreenchange', onF);
    document.addEventListener('visibilitychange', onV);
    const mo = new MutationObserver((list) => (d.mut += list.length));
    mo.observe(bottom, { attributes: true, childList: true, subtree: true });
    mo.observe(root, { attributes: true });
    cleanup.push(
      () => vv?.removeEventListener('resize', onR),
      () => vv?.removeEventListener('scroll', onS),
      () => window.removeEventListener('resize', onW),
      () => document.removeEventListener('fullscreenchange', onF),
      () => document.removeEventListener('visibilitychange', onV),
      () => mo.disconnect(),
    );
  }
  const uiDebug = (): Record<string, string> => ({
    ui: `build ${BUILD} typing ${typing ? 1 : 0} focus ${d.focus}/${d.blur} mut ${d.mut}`,
    vk: vk ? `overlay ${vk.overlaysContent ? 1 : 0} h ${Math.round(vk.boundingRect.height)}` : 'none',
    kb: `vv ${vv ? Math.round(vv.height) : '-'}+${vv ? Math.round(vv.offsetTop) : '-'} inner ${window.innerHeight} r ${d.vvR} s ${d.vvS} win ${d.winR} fs ${d.fs} vis ${d.vis}`,
  });
  return { stage, view, bottom, root, setStatus, cleanup, debugBox, uiDebug };
}

function leave(): void {
  session?.stop();
  session = null;
  showLanding();
}

type ArKind = 'device' | 'sim' | 'simworld';

/** 진단 상자(?debug=1)를 주기적으로 채운다. */
function runDebug(box: HTMLElement | null, read: () => Record<string, string | number>): () => void {
  if (!box) return () => {};
  const id = window.setInterval(() => {
    box.textContent = Object.entries(read())
      .map(([k, v]) => `${k}: ${v}`)
      .join(String.fromCharCode(10));
  }, 250);
  return () => clearInterval(id);
}

const XR_UNSUPPORTED = '이 기기나 브라우저는 AR(공간 인식)을 지원하지 않아요. Android 의 Chrome 에서 열어 주세요. 지금은 아래 "AR 없이 2D로 보기"로 같은 내용을 볼 수 있어요.';
const XR_FAILED = 'AR 을 시작하지 못했어요. 카메라 권한을 허용했는지 확인하고 다시 시도하거나, 아래 "AR 없이 2D로 보기"를 눌러 주세요.';

/**
 * 실제 기기의 AR 은 WebXR(ARCore) 공간 고정 한 가지뿐이다.
 * 카메라 영상 + 자이로 방식(이른바 60fps 모드)은 실제 폰에서 떨림이 심해 뺐다. 지원하지 않는 기기는 2D 보기로 안내한다.
 * (영상 방식 코드는 개발용 모의 카메라 ?mode=sim 에서만 쓴다.)
 */
async function startAr(kind: ArKind): Promise<void> {
  session?.stop();
  session = null;
  if (kind !== 'device') return startVideoAr(kind);
  if (!(await xrSupported())) return showLanding(XR_UNSUPPORTED);

  const [, { XrArView }] = await loadAr();
  const ui = buildExperience('ar', false);
  ui.root.classList.add('xr');
  const fail = (why: unknown) => {
    console.warn('AR 시작 실패:', why);
    session?.stop();
    session = null;
    showLanding(XR_FAILED);
  };
  const xr = new XrArView(ui.stage, {
    onState: (s) => ui.setStatus(s),
    onTap: (p) => p && ui.stage.selectPanel(p),
    onEnd: () => leave(),
    onGiveUp: (reason) => fail(reason),
  });
  const stopDebug = runDebug(ui.debugBox, () => ({ ...xr.debug, ...ui.uiDebug() }));
  session = {
    stage: ui.stage,
    stop: () => {
      stopDebug();
      ui.cleanup.forEach((f) => f());
      xr.stop();
      ui.stage.dispose();
    },
  };
  try {
    await xr.start(ui.root);
  } catch (e) {
    fail(e);
  }
}

/** 카메라 영상 경로. 개발용 모의 카메라(?mode=sim, simworld)에서만 쓴다. */
async function startVideoAr(kind: ArKind): Promise<void> {
  const [{ ArView }] = await loadAr();
  const ui = buildExperience('ar', kind !== 'device');
  const ar = new ArView(ui.view, ui.stage, {
    onState: (s) => ui.setStatus(s),
    onTap: (p) => p && ui.stage.selectPanel(p),
  });
  const stopDebug = runDebug(ui.debugBox, () => ({ ...ar.debug, ...ui.uiDebug() }));
  session = {
    stage: ui.stage,
    stop: () => {
      stopDebug();
      ui.cleanup.forEach((f) => f());
      ar.stop();
      ui.stage.dispose();
    },
  };
  try {
    await ar.start({
      simulate: kind !== 'device',
      simWorld: kind === 'simworld',
      noGyro: params.get('gyro') === '0',
      noCalibration: params.get('cal') === '0',
      noWorker: params.get('worker') === '0',
      noFrameClock: params.get('vfc') === '0',
      latencyMs: params.get('lat') ? Number(params.get('lat')) : undefined,
    });
    if (DEV) exposeDebug(ui.stage, ar, null);
  } catch (e) {
    console.error(e);
    session.stop();
    session = null;
    const msg =
      e instanceof CameraError
        ? e.kind === 'denied'
          ? '카메라 권한이 거부됐어요. 주소창의 자물쇠 → 권한에서 카메라를 허용한 뒤 다시 시도하거나, 아래 "AR 없이 2D로 보기"를 눌러 주세요.'
          : `${e.message} 아래 "AR 없이 2D로 보기"로도 같은 내용을 볼 수 있어요.`
        : 'AR 을 시작하지 못했어요. "AR 없이 2D로 보기"를 이용해 주세요.';
    showLanding(msg);
  }
}

async function startViewer(): Promise<void> {
  session?.stop();
  const ui = buildExperience('viewer', false);
  const viewer = new ViewerView(ui.view, ui.stage, (p) => p && ui.stage.selectPanel(p));
  const ro = new ResizeObserver(() => (viewer.bottomInset = ui.bottom.offsetHeight));
  ro.observe(ui.bottom);
  session = {
    stage: ui.stage,
    stop: () => {
      ui.cleanup.forEach((f) => f());
      ro.disconnect();
      viewer.stop();
      ui.stage.dispose();
    },
  };
  try {
    await viewer.start();
    if (DEV) exposeDebug(ui.stage, null, viewer);
  } catch (e) {
    console.error(e);
    session.stop();
    session = null;
    showLanding('이 기기에서는 3D 화면을 그릴 수 없어요(WebGL 을 쓸 수 없음).');
  }
}

/* ───────────────────────── 개발용 진단 훅 ───────────────────────── */

function exposeDebug(stage: LabStage, ar: ArView | null, viewer: ViewerView | null): void {
  const snap = async (name: string) => {
    const gl = ar ? ar.glCanvas : viewer!.glCanvas;
    const rect = gl.getBoundingClientRect();
    const host = document.getElementById('view')!.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = Math.round(host.width);
    out.height = Math.round(host.height);
    const c = out.getContext('2d')!;
    c.fillStyle = '#12264a';
    c.fillRect(0, 0, out.width, out.height);
    if (ar) c.drawImage(ar.videoElement, rect.left - host.left, rect.top - host.top, rect.width, rect.height);
    c.drawImage(gl, rect.left - host.left, rect.top - host.top, rect.width, rect.height);
    const blob: Blob = await new Promise((r) => out.toBlob((b) => r(b!), 'image/png'));
    const res = await fetch(`/__dev/save?name=${name}.png`, { method: 'POST', body: blob });
    return res.text();
  };
  /**
   * 모의 카메라에서 정합 오차와 떨림을 잰다 (영상 픽셀, 720×1280 기준).
   *   error  = 네 꼭짓점 오차 크기의 평균
   *   jitter = 꼭짓점 오차가 시간에 따라 흔들리는 정도 (표준편차) — "부들부들"의 크기
   * 화면의 영상이 실제보다 얼마나 늦는지 모르므로 여러 지연값으로 비교해 가장 잘 맞는 것을 고른다.
   */
  const measure = async (seconds = 3) => {
    if (!ar) return null;
    const lags = [0, 17, 33, 50, 67, 83, 100, 117];
    const samples: number[][][] = lags.map(() => []);
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) {
      await new Promise((r) => requestAnimationFrame(r));
      lags.forEach((lag, i) => {
        const e = ar.devCornerError(lag);
        if (e) samples[i].push(e);
      });
    }
    let best: { lag: number; error: number; jitter: number; n: number } | null = null;
    lags.forEach((lag, i) => {
      const s = samples[i];
      if (s.length < 10) return;
      const mean = new Array(8).fill(0);
      for (const e of s) for (let k = 0; k < 8; k++) mean[k] += e[k] / s.length;
      let err = 0;
      let jit = 0;
      for (const e of s)
        for (let c = 0; c < 4; c++) {
          err += Math.hypot(e[c * 2], e[c * 2 + 1]);
          jit += (e[c * 2] - mean[c * 2]) ** 2 + (e[c * 2 + 1] - mean[c * 2 + 1]) ** 2;
        }
      const r = { lag, error: +(err / (s.length * 4)).toFixed(2), jitter: +Math.sqrt(jit / (s.length * 4)).toFixed(2), n: s.length };
      if (!best || r.jitter < best.jitter) best = r;
    });
    return best;
  };
  (window as unknown as { __rabbit: unknown }).__rabbit = { stage, ar, viewer, chat, snap, scenes, measure };
}

/* ───────────────────────── 시작 ───────────────────────── */

const want = params.get('mode');
if (want === 'viewer') void startViewer();
else if (DEV && (want === 'sim' || want === 'simworld')) void startAr(want);
else showLanding();
