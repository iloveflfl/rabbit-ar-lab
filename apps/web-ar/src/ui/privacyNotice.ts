/**
 * 개인정보 처리 안내. 홈 맨 아래의 회색 글자나 채팅 창의 안내 글자를 눌러야 열린다.
 * 여기 적는 내용은 실제 동작과 같아야 한다: 질문 문장은 발표자 PC 의 logs/ 에 남고(scripts/desktop-device.ts),
 * 릴레이는 IP 를 속도 제한에만 쓰고 저장하지 않는다(apps/relay-worker). 동작을 바꾸면 이 글도 함께 고친다.
 */
import { h } from './dom';

export const PRIVACY_LABEL = '개인정보 처리 안내';
/** 채팅 입력창 바로 아래에 늘 보이는 한 줄. 수집 사실은 숨기지 않고 입력하는 자리에서 알린다. */
export const CHAT_NOTICE = '질문은 기록·공유될 수 있어요';

export const PRIVACY_SECTIONS: Array<{ title: string; body: string[] }> = [
  {
    title: '한눈에',
    body: [
      'AI 채팅에 질문을 보내면 그 질문 문장이 기록되고, 개인을 알아볼 수 없는 형태로 외부에 공유·공개될 수 있습니다. 채팅을 이용하면 이에 동의한 것으로 봅니다.',
      '이름·학번·연락처처럼 본인이나 다른 사람을 알아볼 수 있는 내용은 입력하지 마세요.',
      '동의하지 않으면 채팅을 쓰지 않으면 됩니다. 채팅 없이도 해설과 3D 시뮬레이션은 모두 볼 수 있습니다.',
    ],
  },
  {
    title: '수집하는 것',
    body: [
      '채팅에 입력한 질문 문장, 보낸 시각, 무작위로 만든 대화 식별값(접속할 때마다 새로 만들며 기기나 사람과 연결되지 않습니다), 질문할 때 보고 있던 장면 정보.',
      '접속 IP 주소는 중계 서버가 도배를 막는 데에만 잠깐 쓰고 기록으로 남기지 않습니다.',
      '이름·계정·위치는 받지 않으며, 광고·추적용 쿠키도 쓰지 않습니다. 화면 설정 몇 가지만 이 기기의 브라우저에 저장합니다.',
    ],
  },
  {
    title: '카메라',
    body: ['카메라 영상은 포스터를 찾는 데에만 이 기기 안에서 쓰이고, 저장하거나 전송하지 않습니다.'],
  },
  {
    title: '쓰는 목적',
    body: ['질문에 답하기, 답변 품질과 전시 운영 개선, 그리고 연구·교육·발표 자료(예: "관람객이 많이 한 질문")로의 활용.'],
  },
  {
    title: '외부 제공·공개',
    body: [
      '질문 문장은 발표·보고서·온라인 게시물 등에 인용되거나 공개될 수 있습니다. 이때 대화 식별값은 빼고 싣습니다. 그래서 질문 안에 개인정보를 적지 않는 것이 중요합니다.',
      '질문은 Cloudflare(미국 법인, 중계 서버)를 거쳐 발표자 PC 로 전달되고, 답은 발표자 PC 에서 도는 AI 가 만듭니다. 외부 AI 회사로는 보내지 않습니다. 이 웹페이지는 GitHub Pages(미국 법인)가 제공하며, 두 회사는 각자의 정책에 따라 접속 기록을 처리할 수 있습니다.',
    ],
  },
  {
    title: '보관',
    body: ['질문 기록은 발표자 PC 에 보관하고, 위 목적에 더 필요하지 않게 되면 지웁니다.'],
  },
  {
    title: '문의·삭제 요청',
    body: ['자신이 보낸 질문의 열람·삭제를 원하면 포스터 발표자(Plasma & Device Laboratory)에게 질문한 시각과 내용을 알려 주세요. 확인되는 범위에서 지웁니다.'],
  },
  {
    title: 'AI 답변에 대해',
    body: ['AI 의 답은 틀릴 수 있습니다. 정확한 내용은 포스터 원문과 발표자의 설명을 기준으로 해 주세요.'],
  },
];

let open: HTMLElement | null = null;

/** host: 안내 창을 붙일 곳. AR 중에는 화면에 보이는 것이 overlay 요소 안쪽뿐이라 그 안에 붙여야 한다. */
export function openPrivacy(host?: HTMLElement | null): void {
  if (open) return;
  const parent = host ?? document.getElementById('xp') ?? document.getElementById('app') ?? document.body;
  const close = () => {
    open?.remove();
    open = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const closeBtn = h('button', { class: 'privacy-close', type: 'button', text: '닫기', onclick: close });
  const card = h(
    'div',
    { class: 'privacy-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': PRIVACY_LABEL },
    h('div', { class: 'privacy-head' }, h('h2', { text: PRIVACY_LABEL }), closeBtn),
    h(
      'div',
      { class: 'privacy-body' },
      ...PRIVACY_SECTIONS.map((s) => h('section', {}, h('h3', { text: s.title }), ...s.body.map((p) => h('p', { text: p })))),
    ),
  );
  open = h('div', { class: 'privacy' }, card);
  open.addEventListener('click', (e) => {
    if (e.target === open) close();
  });
  document.addEventListener('keydown', onKey);
  parent.append(open);
  closeBtn.focus();
}
