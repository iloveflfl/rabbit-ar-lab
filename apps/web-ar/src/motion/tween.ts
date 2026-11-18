/** 작은 모션 엔진: 이징, 트윈, 지연 호출, 일시정지. 외부 의존성 없음. */

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t: number) => 1 - Math.pow(1 - t, 4),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
  },
  outBounce: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
} satisfies Record<string, Ease>;

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 프레임률과 무관한 지수 감쇠 보간 계수. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

interface Tween {
  target: object | null;
  elapsed: number;
  delay: number;
  duration: number;
  ease: Ease;
  step: (k: number) => void;
  done?: () => void;
  dead: boolean;
}

export interface TweenOpts {
  delay?: number;
  ease?: Ease;
  onUpdate?: (k: number) => void;
  onComplete?: () => void;
}

export class Motion {
  private tweens: Tween[] = [];
  paused = false;
  /** 전체 경과 시간(초). 일시정지 중에는 흐르지 않는다. */
  time = 0;

  update(dt: number): void {
    if (this.paused) return;
    this.time += dt;
    const list = this.tweens;
    for (let i = 0; i < list.length; i++) {
      const tw = list[i];
      if (tw.dead) continue;
      tw.elapsed += dt;
      const local = tw.elapsed - tw.delay;
      if (local < 0) continue;
      const k = tw.duration <= 0 ? 1 : clamp01(local / tw.duration);
      tw.step(tw.ease(k));
      if (k >= 1) {
        tw.dead = true;
        tw.done?.();
      }
    }
    if (list.length > 64 || list.some((t) => t.dead)) this.tweens = list.filter((t) => !t.dead);
  }

  /** 숫자 속성들을 목표값으로 보간한다. 같은 대상의 같은 속성을 다루던 이전 트윈은 덮어쓴다. */
  to<T extends object>(target: T, props: Partial<Record<keyof T, number>>, duration: number, opts: TweenOpts = {}): void {
    const keys = Object.keys(props) as Array<keyof T>;
    let from: number[] | null = null;
    const tw: Tween = {
      target,
      elapsed: 0,
      delay: opts.delay ?? 0,
      duration,
      ease: opts.ease ?? ease.outCubic,
      dead: false,
      done: opts.onComplete,
      step: (k) => {
        if (!from) from = keys.map((key) => target[key] as unknown as number);
        for (let i = 0; i < keys.length; i++) (target[keys[i]] as unknown as number) = lerp(from[i], props[keys[i]] as number, k);
        opts.onUpdate?.(k);
      },
    };
    this.tweens.push(tw);
  }

  /** 0→1 진행값만 필요한 경우. */
  run(duration: number, onUpdate: (k: number) => void, opts: Omit<TweenOpts, 'onUpdate'> = {}): void {
    this.tweens.push({ target: null, elapsed: 0, delay: opts.delay ?? 0, duration, ease: opts.ease ?? ease.linear, dead: false, done: opts.onComplete, step: onUpdate });
  }

  after(seconds: number, fn: () => void, owner: object | null = null): void {
    this.tweens.push({ target: owner, elapsed: 0, delay: seconds, duration: 0, ease: ease.linear, dead: false, step: () => {}, done: fn });
  }

  kill(target: object): void {
    for (const t of this.tweens) if (t.target === target) t.dead = true;
  }

  killAll(): void {
    this.tweens = [];
  }
}
