/**
 * 화면 아래 채팅. 카메라/AR 위에 얹는 일반 HTML 이다(3D 텍스처가 아니다).
 * 모든 글자는 textContent 로 넣으므로 질문·답변에 HTML 이 섞여 있어도 실행되지 않는다.
 */
import { type FactId, type HighlightId, LIMITS, type TopicId } from '@rabbit/shared';
import type { Answer, ChatController, LinkStatus } from '../chat/chatController';
import { h } from './dom';

export const QUICK_PROMPTS = ['왜 영하 50도인데 기판은 73도야?', 'ICP랑 CCP는 뭐가 달라?', '플라즈마가 뭐야?', '냉각을 왜 3분씩 했어?'];

const FACT_LABEL: Record<FactId, string> = {
  semester1_si_glass_benchmark: '지난 학기 Si·유리',
  sic_continuous_minus50: '120초 연속 측정',
  sic_cyclic_minus50: '30초 ON / 3분 냉각',
  sic_etch_rate_setpoints: 'SiC 식각률',
  sic_mounting_comparison: '받침 구조 비교',
  cu_profile_postprocessing: 'Cu 표면 단차',
  mo_reference_etch: 'Mo 참고 실험',
};

const REASON: Record<string, string> = {
  unconfigured: 'AI 서버가 연결돼 있지 않아요',
  offline: 'AI 서버가 꺼져 있어요',
  device_disconnected: 'AI 서버 연결이 끊겼어요',
  timeout: '응답이 너무 늦었어요',
  busy: '질문이 몰려 있어요',
  rate_limited: '질문이 너무 빨랐어요',
  budget_exhausted: '오늘 답변 횟수를 다 썼어요',
  device_error: 'AI 서버에 문제가 생겼어요',
};

export interface ChatPanelHooks {
  /** 지금 보고 있는 장면의 주제·패널 (질문의 문맥으로 함께 보낸다) */
  context(): { topic: TopicId; panel: HighlightId | null };
  onThinking(on: boolean): void;
  onTalking(on: boolean): void;
  onAnswer(a: Answer): void;
  onStateChange(state: 'idle' | 'peek' | 'open'): void;
  /** 입력창에 커서가 들어갔다/나왔다 */
  onTyping(on: boolean): void;
}

export class ChatPanel {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly link: HTMLElement;
  private readonly quick: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private state: 'idle' | 'peek' | 'open' = 'idle';

  constructor(private readonly chat: ChatController, private readonly hooks: ChatPanelHooks) {
    this.log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
    this.input = h('input', { type: 'text', placeholder: '궁금한 것을 물어보세요', maxlength: LIMITS.maxMessageChars, enterkeyhint: 'send', autocomplete: 'off', 'aria-label': '질문 입력' });
    this.sendBtn = h('button', { class: 'send', type: 'submit', 'aria-label': '보내기', text: '↑' });
    this.link = h('div', { class: 'link' });
    this.quick = h('div', { class: 'quick' }, ...QUICK_PROMPTS.map((q) => h('button', { class: 'chip q', type: 'button', text: q, onclick: () => this.submit(q) })));
    this.toggleBtn = h('button', { type: 'button', text: '펼치기', onclick: () => this.setState(this.state === 'open' ? 'peek' : 'open') });
    const closeBtn = h('button', { type: 'button', text: '닫기', onclick: () => this.setState('idle') });
    const form = h('form', { class: 'chat-bar' }, this.input, this.sendBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit(this.input.value);
    });
    this.el = h('div', { class: 'chat', 'data-state': 'idle' }, h('div', { class: 'chat-top' }, h('span', { text: 'AI 가이드와의 대화' }), h('span', { class: 'grow' }), this.toggleBtn, closeBtn), this.log, this.quick, form, this.link);
    // 입력 중 표시: 잠깐의 blur(보내기 버튼을 누르는 순간 등)에 화면이 출렁이지 않게 조금 늦춰서 끈다.
    let blurTimer = 0;
    this.input.addEventListener('focus', () => {
      clearTimeout(blurTimer);
      this.hooks.onTyping(true);
    });
    this.input.addEventListener('blur', () => {
      blurTimer = window.setTimeout(() => {
        if (document.activeElement !== this.input) this.hooks.onTyping(false);
      }, 200);
    });
    chat.onStatus = (s) => this.renderLink(s);
    this.renderLink(chat.linkStatus);
  }

  private renderLink(s: LinkStatus): void {
    const dot = h('span', { class: `dot ${s === 'online' ? 'online' : s === 'busy' ? 'busy' : ''}` });
    const text =
      s === 'online'
        ? 'AI 온라인 · 발표자 PC의 로컬 AI가 답해요'
        : s === 'busy'
          ? '질문이 몰려 있어요 · 조금 기다려 주세요'
          : s === 'connecting'
            ? 'AI에 연결하는 중…'
            : 'AI 오프라인 · 미리 준비한 답변으로 알려 드려요';
    this.link.replaceChildren(dot, text);
  }

  private setState(s: 'idle' | 'peek' | 'open'): void {
    this.state = s;
    this.el.dataset.state = s;
    this.toggleBtn.textContent = s === 'open' ? '접기' : '펼치기';
    this.quick.hidden = s === 'open';
    this.hooks.onStateChange(s);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private bubble(cls: string, text: string): HTMLElement {
    const el = h('div', { class: `msg ${cls}` });
    el.textContent = text;
    this.log.append(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  submit(text: string): void {
    const message = text.trim();
    if (!message || this.chat.busy) return;
    const ctx = this.hooks.context();
    const mine = this.bubble('me', message);
    const reply = this.bubble('rabbit wait', '');
    const body = h('span');
    reply.append(body);
    const ok = this.chat.ask(message, ctx.topic, ctx.panel, {
      onQueued: () => {},
      onDelta: (soFar) => {
        if (reply.classList.contains('wait')) {
          reply.classList.remove('wait');
          this.hooks.onThinking(false);
          this.hooks.onTalking(true);
        }
        // 스트리밍 중에는 맨 끝의 '#동작:' 태그 조각이 보이지 않게 가린다.
        body.textContent = soFar.replace(/\s*#[^\n]*$/, '');
        this.log.scrollTop = this.log.scrollHeight;
      },
      onFinal: (a) => {
        reply.classList.remove('wait');
        body.textContent = a.reply;
        const meta = h('div', { class: 'meta' });
        meta.append(
          h('span', {
            class: `badge ${a.engine}`,
            text: a.engine === 'geniex' ? '발표자 폰의 온디바이스 AI' : a.engine === 'lmstudio' ? '발표자 PC의 로컬 AI' : a.engine === 'mock' ? 'MOCK · 개발용 가짜 서버' : '미리 준비한 답변',
          }),
        );
        if (a.fallbackReason) meta.append(h('span', { class: 'badge', text: REASON[a.fallbackReason] ?? '서버가 답하지 못했어요' }));
        for (const f of a.sourceFactIds) meta.append(h('span', { class: 'badge', text: `근거: ${FACT_LABEL[f]}` }));
        reply.append(meta);
        this.sendBtn.disabled = false;
        this.hooks.onThinking(false);
        this.hooks.onTalking(false);
        this.hooks.onAnswer(a);
        this.log.scrollTop = this.log.scrollHeight;
      },
    });
    if (!ok) {
      mine.remove();
      reply.remove();
      return;
    }
    this.input.value = '';
    // 보낸 뒤에는 키보드를 내려서 답변과 토끼가 보이게 한다.
    this.input.blur();
    this.sendBtn.disabled = true;
    this.hooks.onThinking(true);
    if (this.state === 'idle') this.setState('peek');
  }

  focusInput(): void {
    this.input.focus();
  }

  blurInput(): void {
    this.input.blur();
  }
}
