import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles.css';
import type { HighlightId, TopicId } from '@rabbit/shared';
import { posterFacts, sceneScripts, scenes } from '@rabbit/content';
import { CameraError, type TrackState, xrSupported } from './ar/support';
import type { ArView } from './ar/tracker';
import { ViewerView } from './ar/viewer';
import { ChatController } from './chat/chatController';
import { paintPage } from './stage/posterArt';
import { LabStage, type Quality, type SceneEvent } from './stage/stage';
import { ChatPanel } from './ui/chatPanel';
import { h } from './ui/dom';
import { LandingHero } from './ui/landingHero';

const DEV = import.meta.env.DEV;
const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;

/** 릴레이 주소는 빌드할 때 VITE_RELAY_URL 로 넣는다(공개 정보). 개발 중에는 ?relay= 로 바꿔 볼 수 있다. */
const relayUrl: string | null = (DEV && params.get('relay')) || import.meta.env.VITE_RELAY_URL || null;
const chat = new ChatController(relayUrl);
chat.connect();

/** 추적 엔진은 용량이 커서 따로 내려받는다. 랜딩이 뜨면 미리 받아 두어 버튼을 누른 뒤 기다리지 않게 한다. */
let arModules: Promise<[typeof import('./ar/tracker'), typeof import('./ar/xrView')]> | null = null;
const loadAr = () =>
  (arModules ??= Promise.all([import('./ar/tracker'), import('./ar/xrView')]).catch((e) => {
    arModules = null; // 다음에 다시 시도할 수 있게
    throw e;
  }));

/**
 * 화면을 여는 동작을 감싼다. 어떤 예외가 나도 빈 화면에 갇히지 않고 첫 화면으로 돌아와 안내한다.
 * 새 버전이 배포된 직후에는 옛 페이지가 없어진 파일을 찾다 실패할 수 있다. 그때는 한 번 새로고침한다.
 */
async function guarded(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.error(e);
    try {
      session?.stop();
    } catch {
      /* 정리 중 오류는 무시 */
    }
    session = null;
    const chunk = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(String(e));
    let reloaded = true;
    try {
      reloaded = sessionStorage.getItem('rabbit.reloaded') === '1';
      if (chunk && !reloaded) sessionStorage.setItem('rabbit.reloaded', '1');
    } catch {
      /* 저장소를 못 쓰면 새로고침하지 않는다 */
    }
    if (chunk && !reloaded) return location.reload();
    showLanding(chunk ? '필요한 파일을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.' : '화면을 여는 중 문제가 생겼어요. 다시 눌러 주세요.');
  }
}

function detectQuality(): Quality {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (params.get('q') === 'low') return 'low';
  if ((nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 3) return 'low';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'low';
  return 'high';
}

/* ───────────────────────── 랜딩 ───────────────────────── */

let hero: LandingHero | null = null;
const closeHero = () => {
  hero?.dispose();
  hero = null;
};
const PART_LABEL = ['시작', 'PART 1 · 기초', 'PART 2 · 장비', 'PART 3 · 결과', 'PART 4 · 진짜 포스터 읽기'];

function showLanding(error?: string): void {
  closeHero();
  hero = new LandingHero();
  const f = posterFacts.facts.find((x) => x.id === 'sic_continuous_minus50') as { chiller_setpoint_c: number; sample_final_c: number };
  const m = posterFacts.metadata;

  const status = h('span', { class: 'land-status' });
  const renderStatus = () => {
    const s = chat.linkStatus;
    const on = s === 'online' || s === 'busy';
    status.replaceChildren(h('span', { class: `dot ${s === 'online' ? 'online' : s === 'busy' ? 'busy' : ''}` }), on ? 'AI 질의응답 온라인' : 'AI 오프라인 · 준비된 답변');
  };
  renderStatus();
  chat.onStatus = renderStatus;

  const arBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => void guarded(() => startAr('device')) }, 'AR로 보기', h('span', { class: 'arrow', text: '→' }));
  const insecure = !window.isSecureContext;
  const slides = sceneScripts.filter((s) => s.part < 4).length;
  const sims = slides - 1 - 6; // 그래프·정리 장면을 뺀 원리 시뮬레이션 수
  const landing = h(
    'section',
    { id: 'landing' },
    h('header', { class: 'land-top' }, h('span', { class: 'brand' }, h('i', {}), '반도체물리학부 학술제'), status),
    h(
      'div',
      { class: 'land-grid' },
      h('div', { class: 'land-visual' }, hero.el),
      h(
        'div',
        { class: 'land-copy' },
        h('p', { class: 'eyebrow', text: 'AR POSTER · CRYOGENIC PLASMA ETCHING' }),
        h('h1', {}, `−${Math.abs(f.chiller_setpoint_c)}°C로 식혔는데,`, h('br'), h('em', { text: `기판은 왜 ${f.sample_final_c}°C일까?` })),
        h('p', {
          class: 'lead',
          text: '포스터를 카메라로 비추면 해설과 3D 시뮬레이션이 그 위에 펼쳐져요. 플라즈마를 처음 듣는 1·2학년도 따라올 수 있게 기초부터 설명해요.',
        }),
        error ? h('div', { class: 'land-error', role: 'alert', text: error }) : null,
        h(
          'div',
          { class: 'cta' },
          arBtn,
          h('button', { class: 'btn btn-ghost', type: 'button', text: 'AR 없이 보기', onclick: () => void guarded(() => startViewer()) }),
          DEV ? h('button', { class: 'btn btn-ghost', type: 'button', text: '[개발] 모의 카메라', onclick: () => void guarded(() => startAr('sim')) }) : null,
        ),
        h(
          'dl',
          { class: 'stats' },
          h('div', {}, h('dt', { text: String(scenes.length) }), h('dd', { text: '장의 해설' })),
          h('div', {}, h('dt', { text: String(sims) }), h('dd', { text: '가지 3D 시뮬레이션' })),
          h('div', {}, h('dt', { text: 'AI' }), h('dd', { text: '에게 바로 질문' })),
        ),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, h('b', { text: '01' }), '카메라를 허용해요'),
          h('li', {}, h('b', { text: '02' }), '포스터 전체를 비춰요'),
          h('li', {}, h('b', { text: '03' }), '넘기며 보고, 궁금하면 물어봐요'),
        ),
        h('p', {
          class: 'land-note',
          text: insecure ? '이 주소는 HTTPS 가 아니라서 카메라를 쓸 수 없어요. "AR 없이 보기"를 이용해 주세요.' : '카메라 영상은 이 기기 안에서만 쓰이고 어디로도 전송되지 않아요.',
        }),
      ),
    ),
    h('footer', { class: 'land-foot' }, h('span', { text: m.corrected_ar_title }), h('span', { text: `${m.authors.join(', ').replace('*', '')} · Plasma & Device Laboratory` })),
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
const BUILD = '1120c';

function buildExperience(mode: 'ar' | 'viewer', simulated: boolean) {
  const debugBox = params.get('debug') ? h('pre', { class: 'debug-box' }) : null;
  closeHero();
  const stage = new LabStage(detectQuality());
  stage.hasPaper = mode === 'ar';
  const view = h('div', { id: 'view' });
  const statusPill = h('div', { class: 'pill status', 'data-s': mode === 'viewer' ? 'viewer' : 'starting', role: 'status' });
  const toggle = h('button', { class: 'pill toggle', type: 'button', 'aria-pressed': 'false', text: '원본 포스터' });
  const scan = h('div', { class: `scan${mode === 'viewer' ? ' off' : ''}` }, h('div', { class: 'scan-frame' }, h('div', { class: 'scan-text' }, '포스터 전체를 네모 안에 맞춰 주세요', h('small', { text: '1 m 쯤 떨어져서, 반사가 없는 각도로' }))));

  /* 자막(토끼 대사) */
  const capPart = h('div', { class: 'caption-part' });
  const capBar = h('i', {});
  const capTitle = h('div', { class: 'caption-title' });
  const capStep = h('span', { class: 'caption-step' });
  const capText = h('p', { class: 'caption-text' });
  const prev = h('button', { type: 'button', 'aria-label': '이전 장면', text: '←', onclick: () => stage.prev() });
  const next = h('button', { type: 'button', 'aria-label': '다음 장면', text: '→', onclick: () => stage.next() });
  const caption = h('div', { class: 'caption', hidden: true }, h('div', { class: 'caption-progress' }, capBar), h('div', { class: 'caption-head' }, h('div', { class: 'caption-titles' }, capPart, capTitle), capStep, h('div', { class: 'nav' }, prev, next)), capText);

  // 자막이 포스터를 가릴 때: 제목을 누르면 대사를 접었다 펼 수 있다.
  const fold = h('button', { type: 'button', 'aria-label': '설명 접기/펴기', text: '−' });
  fold.addEventListener('click', () => {
    const min = caption.classList.toggle('min');
    fold.textContent = min ? '+' : '−';
  });
  caption.querySelector('.nav')!.prepend(fold);

  const chipEls = sceneScripts.map((s, i) => h('button', { class: `chip${i > 0 && sceneScripts[i - 1].part !== s.part ? ' gap' : ''}`, type: 'button', text: s.chip, onclick: () => stage.goScene(s.id) }));
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
    capPart.textContent = PART_LABEL[e.part] ?? '';
    capStep.textContent = `${String(e.index + 1).padStart(2, '0')} / ${e.total}`;
    capBar.style.width = `${((e.index + 1) / e.total) * 100}%`;
    root.style.setProperty('--accent', e.accent);
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
    toggle.textContent = toOriginal ? '해설 보기' : '원본 포스터';
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
      s === 'starting' ? '카메라를 준비하는 중…' : s === 'searching' ? '포스터를 찾는 중…' : s === 'tracking' ? '포스터 인식됨' : s === 'lost' ? '포스터를 놓쳤어요 · 다시 비춰 주세요' : '3D 보기 · 끌어서 돌려 보세요';
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

const XR_UNSUPPORTED = '이 기기나 브라우저는 AR(공간 인식)을 지원하지 않아요. Android 의 Chrome 에서 열어 주세요. 지금은 아래 "AR 없이 보기"로 같은 내용을 볼 수 있어요.';
const XR_FAILED = 'AR 을 시작하지 못했어요. 카메라 권한을 허용했는지 확인하고 다시 시도하거나, 아래 "AR 없이 보기"를 눌러 주세요.';

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
          ? '카메라 권한이 거부됐어요. 주소창의 자물쇠 → 권한에서 카메라를 허용한 뒤 다시 시도하거나, 아래 "AR 없이 보기"를 눌러 주세요.'
          : `${e.message} 아래 "AR 없이 보기"로도 같은 내용을 볼 수 있어요.`
        : 'AR 을 시작하지 못했어요. "AR 없이 보기"를 이용해 주세요.';
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
    c.fillStyle = '#05070d';
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
  /** 슬라이드 한 장(3D 소품 제외)을 PNG 로 저장한다. */
  const page = async (i: number) => {
    const c = document.createElement('canvas');
    paintPage(c, i);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    return (await fetch(`/__dev/save?name=page_${i}.png`, { method: 'POST', body: blob })).text();
  };
  (window as unknown as { __rabbit: unknown }).__rabbit = { stage, ar, viewer, chat, snap, scenes, measure, page };
}

/* ───────────────────────── 시작 ───────────────────────── */

const want = params.get('mode');
if (want === 'viewer') void guarded(() => startViewer());
else if (DEV && (want === 'sim' || want === 'simworld')) void guarded(() => startAr(want));
else showLanding();

// 그래픽 장치를 잃으면(메모리 부족, 탭 전환 등) 화면이 멈춘 채 남는다. 첫 화면으로 돌아가 다시 시작하게 한다.
document.addEventListener(
  'webglcontextlost',
  () => {
    if (!session) return;
    try {
      session.stop();
    } catch {
      /* 정리 중 오류는 무시 */
    }
    session = null;
    showLanding('화면 그리기가 중단됐어요. 다시 시작해 주세요.');
  },
  true,
);
// 놓친 예외가 있어도 기록은 남긴다 (화면은 그대로 둔다).
window.addEventListener('unhandledrejection', (e) => console.error('처리되지 않은 오류:', e.reason));
