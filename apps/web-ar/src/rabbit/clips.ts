/**
 * 토끼 애니메이션 클립. 전부 리그(rig.ts)의 부위를 보간해서 만든다.
 * 실행 시점에 그림을 새로 만들지 않는다 — LLM 은 클립 ID 만 고를 수 있다.
 */
import type { RabbitClip } from '@rabbit/shared';
import { clamp01, ease, smoothstep } from '../motion/tween';
import { type MouthId, type Pose, blendPose, copyPose, makePose, resetPose } from './rig';

export interface ClipDef {
  id: RabbitClip;
  /** 초. loop 가 false 면 끝난 뒤 idle 로 돌아간다. */
  duration: number;
  loop: boolean;
  description: string;
  /** base(숨쉬기가 적용된 포즈) 위에 덧입힌다. side: 1 = 화면 오른쪽을 향함, -1 = 왼쪽 */
  apply(p: Pose, t: number, side: 1 | -1): void;
}

const sin = Math.sin;
const TAU = Math.PI * 2;
/** 0→1→0 종 모양 */
const bell = (t: number, a: number, b: number, c: number, d: number) => smoothstep(a, b, t) * (1 - smoothstep(c, d, t));
/** 바깥쪽 팔: side 가 1 이면 오른팔(armR), -1 이면 왼팔(armL). 회전 부호도 함께 뒤집는다. */
const outerArm = (p: Pose, side: 1 | -1) => (side === 1 ? p.parts.armR : p.parts.armL);
const innerArm = (p: Pose, side: 1 | -1) => (side === 1 ? p.parts.armL : p.parts.armR);

export const CLIPS: Record<RabbitClip, ClipDef> = {
  rabbit_idle: {
    id: 'rabbit_idle',
    duration: 3,
    loop: true,
    description: '숨쉬기, 귀 살랑임, 눈 깜박임',
    apply() {},
  },

  rabbit_talk: {
    id: 'rabbit_talk',
    duration: 2.4,
    loop: true,
    description: '입 모양 변화와 작은 손짓',
    apply(p, t, side) {
      const a = outerArm(p, side);
      a.r += -side * (34 + sin(t * TAU * 0.85) * 12);
      innerArm(p, side).r += side * (6 + sin(t * TAU * 0.6 + 1) * 4);
      p.parts.head.r += sin(t * TAU * 0.42) * 2.5;
      p.parts.head.y += sin(t * TAU * 1.7) * 1.2;
    },
  },

  rabbit_point: {
    id: 'rabbit_point',
    duration: 3,
    loop: true,
    description: '포인터로 그래프나 모형을 가리킨다',
    apply(p, t, side) {
      const k = ease.outBack(clamp01(t / 0.45));
      const a = outerArm(p, side);
      a.r += -side * (104 * k + sin(t * TAU * 0.5) * 3);
      p.pointer = true;
      // 포인터는 오른팔에 달려 있다. 왼쪽을 가리킬 때는 오른팔을 몸 앞으로 가로질러 뻗는다.
      if (side === -1) {
        p.parts.armR.r += 128 * k + sin(t * TAU * 0.5) * 3;
        p.parts.armL.r -= 104 * k; // 왼팔은 원위치
      }
      p.parts.head.r += side * 4 * k;
      p.parts.body.r += side * 2.5 * k;
      p.lookX = side * 3.5 * k;
      p.lookY = -1.5 * k;
      p.parts.browL.y -= 2 * k;
      p.parts.browR.y -= 2 * k;
    },
  },

  rabbit_surprised: {
    id: 'rabbit_surprised',
    duration: 1.5,
    loop: false,
    description: '눈이 커지고 두 귀가 번쩍 들린다',
    apply(p, t) {
      const hit = bell(t, 0, 0.1, 1.05, 1.45);
      const jump = Math.max(0, sin(clamp01(t / 0.38) * Math.PI));
      p.parts.root.y -= jump * 30;
      p.parts.root.sy *= 1 + jump * 0.06 - bell(t, 0.36, 0.42, 0.46, 0.6) * 0.07;
      p.parts.root.x += sin(t * 70) * 2.2 * bell(t, 0.05, 0.12, 0.5, 0.9);
      p.parts.earL.r += 9 * hit;
      p.parts.earR.r -= 13 * hit;
      p.parts.earL.sy *= 1 + 0.13 * hit;
      p.parts.earR.sy *= 1 + 0.13 * hit;
      p.parts.armL.r += 58 * hit;
      p.parts.armR.r -= 58 * hit;
      p.parts.browL.y -= 7 * hit;
      p.parts.browR.y -= 7 * hit;
      if (hit > 0.3) {
        p.eyes = 'wide';
        p.mouth = 'o';
      }
    },
  },

  rabbit_cooling: {
    id: 'rabbit_cooling',
    duration: 2.6,
    loop: false,
    description: '냉각 버튼을 꾹 누르고 시원해한다',
    apply(p, t, side) {
      const a = outerArm(p, side);
      const reach = bell(t, 0, 0.3, 1.25, 1.55);
      const press = bell(t, 0.42, 0.52, 0.6, 0.78) + bell(t, 0.86, 0.96, 1.04, 1.22);
      a.r += -side * (88 * reach);
      a.x += side * press * 9;
      a.sy *= 1 + press * 0.08;
      p.parts.body.r += side * (3 * reach + press * 2);
      p.lookX = side * 3 * reach;
      // 시원~ : 살짝 떨고 눈웃음
      const brr = bell(t, 1.5, 1.7, 2.3, 2.6);
      p.parts.root.x += sin(t * 55) * 1.8 * brr;
      p.parts.armL.r -= 24 * brr;
      p.parts.armR.r += 24 * brr;
      p.parts.earL.r += 8 * brr;
      p.parts.earR.r -= 6 * brr;
      if (brr > 0.4) {
        p.eyes = 'happy';
        p.mouth = 'grin';
      }
    },
  },

  rabbit_cheer: {
    id: 'rabbit_cheer',
    duration: 1.9,
    loop: false,
    description: '두 팔을 들고 폴짝폴짝 뛴다',
    apply(p, t) {
      const on = bell(t, 0, 0.14, 1.5, 1.85);
      const hopT = clamp01(t / 1.5) * 2; // 두 번
      const phase = hopT % 1;
      const hop = hopT < 2 ? sin(phase * Math.PI) : 0;
      const land = hopT < 2 ? Math.max(0, 1 - phase * 6) + Math.max(0, (phase - 0.85) * 6) : 0;
      p.parts.root.y -= hop * 44 * on;
      p.parts.root.sy *= 1 + hop * 0.07 - land * 0.09 * on;
      p.parts.root.sx *= 1 - hop * 0.04 + land * 0.07 * on;
      p.parts.armL.r += (148 + sin(t * 22) * 9) * on;
      p.parts.armR.r -= (148 + sin(t * 22 + 1) * 9) * on;
      p.parts.head.r += sin(t * 9) * 4 * on;
      p.parts.tail.r += sin(t * 30) * 14 * on;
      if (on > 0.3) {
        p.eyes = 'happy';
        p.mouth = 'grin';
      }
    },
  },

  rabbit_think: {
    id: 'rabbit_think',
    duration: 3.2,
    loop: true,
    description: '고개를 갸웃하고 앞발을 볼에 댄다',
    apply(p, t) {
      const k = ease.outCubic(clamp01(t / 0.5));
      p.parts.head.r += (9 + sin(t * TAU * 0.3) * 2) * k;
      p.parts.armR.r -= (150 + sin(t * TAU * 0.45) * 3) * k;
      p.parts.armR.x -= 6 * k;
      p.parts.armL.r -= 8 * k;
      p.parts.earR.r += 20 * k;
      p.parts.earL.r += 4 * k;
      p.parts.browL.y -= 5 * k;
      p.parts.browL.r -= 10 * k;
      p.parts.browR.r += 8 * k;
      p.lookX = -3.5 * k;
      p.lookY = -4 * k;
      p.mouth = k > 0.4 ? 'o' : 'smile';
    },
  },

  rabbit_wave: {
    id: 'rabbit_wave',
    duration: 2.3,
    loop: false,
    description: '손을 흔들며 인사한다',
    apply(p, t, side) {
      const on = bell(t, 0, 0.3, 1.8, 2.25);
      const a = outerArm(p, side);
      a.r += -side * (148 + sin(t * TAU * 2.6) * 20) * on;
      innerArm(p, side).r += side * 8 * on;
      p.parts.head.r += side * 7 * on;
      p.parts.body.r += side * 3 * on;
      p.parts.root.y -= Math.abs(sin(t * TAU * 1.3)) * 5 * on;
      if (on > 0.5) {
        p.eyes = t > 0.5 && t < 1.5 ? 'happy' : 'open';
        p.mouth = 'grin';
      }
    },
  },
};

/** 숨쉬기·귀 살랑임 등 항상 깔리는 미세 동작 */
function applyIdle(p: Pose, time: number): void {
  const breath = sin(time * TAU * 0.33);
  p.parts.body.sy *= 1 + breath * 0.012;
  p.parts.head.y += breath * 1.4;
  p.parts.head.r += sin(time * TAU * 0.11) * 1.2;
  p.parts.earL.r += sin(time * TAU * 0.27) * 2.4;
  p.parts.earR.r += sin(time * TAU * 0.23 + 1.3) * 3.1;
  p.parts.armL.r += sin(time * TAU * 0.33 + 0.5) * 1.6;
  p.parts.armR.r -= sin(time * TAU * 0.33) * 1.6;
  p.parts.tail.r += sin(time * TAU * 0.5) * 5;
  // 가끔 귀를 탈탈
  const flick = time % 6.2;
  if (flick < 0.3) p.parts.earR.r += sin((flick / 0.3) * Math.PI) * 13;
}

const TALK_SEQ: MouthId[] = ['open', 'smile', 'wide', 'open', 'smile', 'open', 'wide', 'smile', 'smile', 'open'];

export class RabbitAnimator {
  time = 0;
  clip: RabbitClip = 'rabbit_idle';
  clipTime = 0;
  side: 1 | -1 = 1;
  /** 채팅 답변이 나오는 동안 true: 입이 움직인다 */
  talking = false;
  /** 대사를 읽는 동안(자막 타이핑 중) true */
  private from = makePose();
  private current = makePose();
  private scratch = makePose();
  readonly pose = makePose();
  private fade = 1;
  private nextBlink = 2.2;
  private blinkLeft = 0;
  // 귀의 2차 동작(관성): 몸이 위아래로 움직이면 귀가 반 박자 늦게 따라온다.
  private earLag = 0;
  private earVel = 0;
  private lastRootY = 0;
  onClipEnd: ((clip: RabbitClip) => void) | null = null;

  play(clip: RabbitClip, side: 1 | -1 = this.side, restart = true): void {
    if (!restart && this.clip === clip && this.side === side) return;
    copyPose(this.pose, this.from);
    this.clip = clip;
    this.side = side;
    this.clipTime = 0;
    this.fade = 0;
  }

  update(dt: number): Pose {
    this.time += dt;
    this.clipTime += dt;
    const def = CLIPS[this.clip];
    if (this.clipTime >= def.duration) {
      if (def.loop) {
        // 등장 구간(0.5초)을 다시 재생하지 않도록 루프는 뒤쪽 구간에서 돈다.
        this.clipTime = Math.max(0.6, this.clipTime - (def.duration - 0.6));
      } else {
        const ended = this.clip;
        this.play(this.talking ? 'rabbit_talk' : 'rabbit_idle');
        this.onClipEnd?.(ended);
      }
    }

    const cur = resetPose(this.current);
    applyIdle(cur, this.time);
    CLIPS[this.clip].apply(cur, this.clipTime, this.side);

    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / 0.24);
      blendPose(this.from, cur, ease.outCubic(this.fade), this.scratch);
      copyPose(this.scratch, this.pose);
    } else {
      copyPose(cur, this.pose);
    }
    const p = this.pose;

    // 눈 깜박임
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blinkLeft = 0.11;
      this.nextBlink = 2.4 + ((this.time * 7.13) % 2.8);
    }
    if (this.blinkLeft > 0) {
      this.blinkLeft -= dt;
      if (p.eyes === 'open') p.eyes = 'closed';
    }

    // 말하는 입
    if (this.talking && (p.mouth === 'smile' || p.mouth === 'open' || p.mouth === 'wide')) {
      p.mouth = TALK_SEQ[Math.floor(this.time * 9) % TALK_SEQ.length];
      p.parts.head.y += sin(this.time * 18) * 0.8;
    }

    // 귀 관성 (스프링)
    const rootY = p.parts.root.y;
    const vy = dt > 0 ? (rootY - this.lastRootY) / dt : 0;
    this.lastRootY = rootY;
    const target = Math.max(-18, Math.min(18, vy * 0.06));
    this.earVel += ((target - this.earLag) * 90 - this.earVel * 11) * dt;
    this.earLag += this.earVel * dt;
    p.parts.earL.r -= this.earLag * 0.8;
    p.parts.earR.r += this.earLag;
    p.parts.earL.sy *= 1 - Math.abs(this.earLag) * 0.003;
    p.parts.earR.sy *= 1 - Math.abs(this.earLag) * 0.003;

    return p;
  }

  /** 설정화 시트용: 클립의 특정 시점 포즈를 그대로 뽑는다(깜박임·관성 없이). */
  static still(clip: RabbitClip, t: number, side: 1 | -1 = 1): Pose {
    const p = makePose();
    CLIPS[clip].apply(p, t, side);
    return p;
  }
}
