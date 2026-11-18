/**
 * 토끼 설정화 시트를 리그 원본(apps/web-ar/src/rabbit/rig.ts)에서 뽑아낸다.
 * 모든 시트가 같은 벡터 부위에서 파생되므로 장면마다 그림체가 달라질 수 없다.
 *
 *   npm run export:rabbit   →  assets/characters/rabbit/
 *
 * 만들지 않는 것: 3/4·측면·후면 턴어라운드. 리그는 정면 한 방향만 있고 AR 에서는 billboard 로
 * 항상 정면을 보여 준다. 다른 각도의 원화는 아직 없으며, 있는 척하는 파일을 만들지 않는다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RABBIT_CLIPS } from '@rabbit/shared';
import { CLIPS, RabbitAnimator } from '../apps/web-ar/src/rabbit/clips';
import { EYES, MOUTHS, PALETTE, PART_IDS, type Pose, VIEW, makePose, rabbitSvg, rabbitSvgGroup } from '../apps/web-ar/src/rabbit/rig';

const out = resolve(import.meta.dirname, '../assets/characters/rabbit');
mkdirSync(out, { recursive: true });
mkdirSync(resolve(out, 'qa'), { recursive: true });

const pose = (edit: (p: Pose) => void = () => {}): Pose => {
  const p = makePose();
  edit(p);
  return p;
};

function sheet(title: string, cells: Array<{ label: string; pose: Pose }>, cols: number): string {
  const cw = 300;
  const ch = 380;
  const rows = Math.ceil(cells.length / cols);
  const W = cols * cw + 40;
  const Hh = rows * ch + 90;
  const scale = 0.52;
  let body = '';
  cells.forEach((c, i) => {
    const x = 20 + (i % cols) * cw;
    const y = 70 + Math.floor(i / cols) * ch;
    body += `<rect x="${x + 6}" y="${y + 6}" width="${cw - 12}" height="${ch - 12}" rx="18" fill="#F3F8FD" stroke="#D5E3F2"/>\n`;
    body += rabbitSvgGroup(c.pose, x + cw / 2, y + ch - 64, scale);
    body += `<text x="${x + cw / 2}" y="${y + ch - 24}" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="700" fill="#12264A">${c.label}</text>\n`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}">\n<rect width="${W}" height="${Hh}" fill="#FFFFFF"/>\n<text x="24" y="44" font-family="sans-serif" font-size="26" font-weight="800" fill="#12264A">${title}</text>\n${body}</svg>\n`;
}

/* 기준형 */
writeFileSync(resolve(out, 'character_master_front.svg'), rabbitSvg(makePose()));

/* 표정 8종 */
const expressions = [
  { label: 'neutral', pose: pose() },
  { label: 'smile', pose: pose((p) => ((p.eyes = 'happy'), (p.mouth = 'grin'))) },
  { label: 'explain', pose: pose((p) => ((p.mouth = 'open'), (p.parts.browL.y = -2), (p.parts.browR.y = -2))) },
  { label: 'surprised', pose: pose((p) => ((p.eyes = 'wide'), (p.mouth = 'o'), (p.parts.browL.y = -7), (p.parts.browR.y = -7), (p.parts.earL.sy = 1.12), (p.parts.earR.sy = 1.12))) },
  { label: 'confused', pose: pose((p) => ((p.mouth = 'o'), (p.parts.head.r = 9), (p.parts.browL.r = -10), (p.parts.browR.r = 8), (p.lookX = -3.5), (p.lookY = -4), (p.parts.earR.r = 20))) },
  { label: 'proud', pose: pose((p) => ((p.eyes = 'closed'), (p.mouth = 'grin'), (p.parts.head.r = -4), (p.parts.browL.y = -3), (p.parts.browR.y = -3))) },
  { label: 'worried', pose: pose((p) => ((p.mouth = 'o'), (p.parts.browL.r = 14), (p.parts.browR.r = -14), (p.parts.browL.y = -3), (p.parts.browR.y = -3), (p.lookY = 3), (p.parts.earL.r = -14), (p.parts.earR.r = 16))) },
  { label: 'relieved', pose: pose((p) => ((p.eyes = 'happy'), (p.mouth = 'smile'), (p.parts.earL.r = -6), (p.parts.earR.r = 8))) },
];
writeFileSync(resolve(out, 'character_expression_sheet.svg'), sheet('토끼 선생님 — 표정 8종 (리그 파생, 확정안)', expressions, 4));

/* 포즈: 클립의 대표 시점 */
const stills: Array<[string, Pose]> = [
  ['standing (idle)', makePose()],
  ['waving', RabbitAnimator.still('rabbit_wave', 0.9)],
  ['pointing_right', RabbitAnimator.still('rabbit_point', 1.5, 1)],
  ['pointing_left', RabbitAnimator.still('rabbit_point', 1.5, -1)],
  ['talking', (() => { const p = RabbitAnimator.still('rabbit_talk', 0.4); p.mouth = 'open'; return p; })()],
  ['surprised', RabbitAnimator.still('rabbit_surprised', 0.3)],
  ['cooling: press', RabbitAnimator.still('rabbit_cooling', 0.55)],
  ['cooling: brr', RabbitAnimator.still('rabbit_cooling', 2.0)],
  ['cheering', RabbitAnimator.still('rabbit_cheer', 0.4)],
  ['thinking', RabbitAnimator.still('rabbit_think', 1.5)],
  ['arms_open', pose((p) => ((p.parts.armL.r = 58), (p.parts.armR.r = -58), (p.mouth = 'grin')))],
  ['leaning', pose((p) => ((p.parts.body.r = 6), (p.parts.head.r = 5), (p.parts.armR.r = -30)))],
];
writeFileSync(resolve(out, 'character_pose_sheet.svg'), sheet('토끼 선생님 — 포즈 12종 (리그 파생, 확정안)', stills.map(([label, p]) => ({ label, pose: p })), 4));

/* 디자인 고정값 */
writeFileSync(
  resolve(out, 'character_lock.json'),
  JSON.stringify(
    {
      status: 'approved_by_owner',
      approved_design: true,
      approved_on: '2026-11-18',
      note: '소유자가 2026-11-18 에 이 디자인을 확정했다. 이 값은 리그 원본에서 자동으로 뽑는다. 이후 외형 변경은 rig.ts 한 곳에서만 하고, 바꾸면 다시 승인받는다.',
      source_of_truth: 'apps/web-ar/src/rabbit/rig.ts',
      medium: '2D vector parts + 2D skeletal rig (no 3D mesh)',
      species: 'anthropomorphic rabbit (kemono chibi)',
      design_view: VIEW,
      palette: PALETTE,
      line: { color: PALETTE.outline, width_main: 5, join: 'round', cap: 'round' },
      proportions_design_units: {
        total_height_feet_to_ear_tip: 470,
        head_width: 236,
        head_height: 196,
        head_to_body_ratio: '약 2등신',
        eye_center_spacing: 104,
        eye_size: [28, 40],
        ear_length: 173,
        ear_base_spacing: 96,
        ear_rest_angle_deg: { left: -11, right: 15 },
        body_height: 120,
        arm_length_shoulder_to_paw: 79,
        tail_radius: 22,
      },
      fixed_features: ['긴 귀 2개(안쪽 분홍)', '주둥이와 ω 입, 앞니', '볼 털·이마 털', '분홍 볼터치', '짧고 둥근 꼬리', '앞발 2·발 2 (발가락 선 2개)', '흰 실험 가운 + 하늘색 밑단·소매', '노란 나비넥타이', '주머니의 눈꽃 심벌'],
      parts: PART_IDS,
      expression_channels: { eyes: EYES, mouth: MOUTHS },
      views_available: ['front'],
      views_missing: ['three_quarter', 'profile', 'back'],
      ar_presentation: 'camera-facing billboard, always front view',
    },
    null,
    2,
  ) + '\n',
);

/* 클립 메타데이터 */
writeFileSync(
  resolve(out, 'clips.json'),
  JSON.stringify(
    {
      note: '클립은 스프라이트 프레임이 아니라 리그 부위의 절차적 보간이다. 구현: apps/web-ar/src/rabbit/clips.ts',
      pivot: { description: '두 발 사이 바닥', design_xy: [VIEW.ox, VIEW.oy] },
      blend_seconds: 0.24,
      clips: RABBIT_CLIPS.map((id) => ({ id, duration_s: CLIPS[id].duration, loop: CLIPS[id].loop, description: CLIPS[id].description })),
    },
    null,
    2,
  ) + '\n',
);

console.log('wrote', out);
