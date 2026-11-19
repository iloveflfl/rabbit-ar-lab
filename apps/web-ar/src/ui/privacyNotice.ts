/**
 * 개인정보 처리 안내. 홈 맨 아래의 회색 글자나 채팅 창의 안내 글자를 눌러야 열린다.
 * 여기 적는 내용은 실제 동작과 같아야 한다: 질문 문장은 발표자 PC 의 logs/ 에 남고(scripts/desktop-device.ts),
 * 릴레이는 IP 를 속도 제한에만 쓰고 저장하지 않는다(apps/relay-worker). 동작을 바꾸면 이 글도 함께 고친다.
 */
import { h } from './dom';

export const PRIVACY_LABEL = '이용약관 · 개인정보 처리 안내';
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
    body: ['질문 기록은 발표자 PC 에 보관합니다. 개인을 알아볼 수 없는 질문 기록은 운영자가 필요하다고 판단하는 동안 기간 제한 없이 보관·활용할 수 있습니다.'],
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

/**
 * 이용약관. 운영자에게 최대한 유리하게 쓰되, 약관규제법상 무효가 되는 문구(고의·중과실 면책, 법이 준 권리의 포기 등)는
 * 넣지 않는다. 그런 조항은 넣어도 효력이 없고 약관 전체의 신뢰만 깎는다.
 */
export const TERMS_SECTIONS: Array<{ title: string; body: string[] }> = [
  {
    title: '약관의 적용',
    body: [
      '이 서비스(AR 해설, 3D 보기, AI 채팅)를 이용하면 이 약관과 아래 개인정보 처리 안내에 동의한 것으로 봅니다. 동의하지 않으면 이용을 멈춰 주세요.',
      '운영자는 포스터 발표자(Plasma & Device Laboratory)입니다. 운영자는 약관을 언제든 고칠 수 있고, 고친 약관은 이 화면에 올린 때부터 적용됩니다.',
    ],
  },
  {
    title: '서비스의 제공과 중단',
    body: [
      '이 서비스는 학술제 전시용으로 무료로, 있는 그대로 제공됩니다. 운영자는 예고 없이 서비스의 전부나 일부를 바꾸거나, 멈추거나, 끝낼 수 있고 이를 유지할 의무가 없습니다.',
      '운영자는 이유를 밝히지 않고 특정 접속이나 질문을 제한·차단하거나 답변을 거절할 수 있습니다.',
    ],
  },
  {
    title: '입력한 내용에 대한 권리',
    body: [
      '채팅에 입력한 질문에 대해, 이용자는 운영자가 이를 기간·지역·횟수 제한 없이 무상으로 저장·복제·수정·편집·번역·인용·공개·배포하고 연구·교육·발표·홍보·서비스 개선에 쓸 수 있도록 허락합니다. 운영자는 이를 제3자에게 다시 허락할 수 있고, 이용자에게 알리거나 대가를 줄 의무가 없습니다.',
      '이용자는 자신이 입력한 내용에 대해 책임을 지며, 다른 사람의 개인정보·비밀·저작물을 입력하지 않습니다.',
    ],
  },
  {
    title: '하면 안 되는 일',
    body: [
      '도배, 자동화된 대량 요청, 서버·AI 를 속이거나 망가뜨리려는 시도, 욕설·혐오·불법적인 내용 입력, 이 서비스의 무단 복제·재배포를 금지합니다. 위반으로 운영자나 제3자에게 손해가 생기면 위반한 이용자가 책임집니다.',
    ],
  },
  {
    title: '보증하지 않는 것과 책임의 한계',
    body: [
      'AI 의 답과 해설은 참고용이며 정확성·완전성·특정 목적에의 적합성을 보증하지 않습니다. 이를 믿고 내린 판단의 결과는 이용자가 책임집니다.',
      '운영자는 법이 허용하는 가장 넓은 범위에서, 서비스의 이용·이용 불가·중단·오류·데이터 손실, 이용 중 기기나 주변에서 생긴 사고로 인한 손해에 대해 책임지지 않습니다. 다만 운영자의 고의 또는 중대한 과실로 생긴 손해는 그렇지 않습니다.',
      'AR 을 볼 때는 주변 사람과 장애물을 살피고, 걸으면서 화면만 보지 마세요.',
    ],
  },
  {
    title: '저작권',
    body: ['포스터, 해설, 그림, 3D 시뮬레이션, 캐릭터 등 이 서비스의 모든 내용에 대한 권리는 운영자와 원저작자에게 있습니다. 개인적인 관람 외의 이용에는 운영자의 허락이 필요합니다.'],
  },
  {
    title: '준거법',
    body: ['이 약관은 대한민국 법에 따릅니다. 약관의 일부가 효력이 없더라도 나머지는 그대로 적용됩니다. 법이 이용자에게 보장하는 권리는 이 약관으로 줄어들지 않습니다.'],
  },
];

let open: HTMLElement | null = null;

const section = (s: { title: string; body: string[] }) => h('section', {}, h('h3', { text: s.title }), ...s.body.map((p) => h('p', { text: p })));

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
      h('h2', { class: 'privacy-group', text: '이용약관' }),
      ...TERMS_SECTIONS.map(section),
      h('h2', { class: 'privacy-group', text: '개인정보 처리 안내' }),
      ...PRIVACY_SECTIONS.map(section),
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
