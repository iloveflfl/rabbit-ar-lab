import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_IDS, RABBIT_CLIPS } from '@rabbit/shared';
import { scenes } from '@rabbit/content';
import { H, HEADER, PANELS, POSTER, QR_ZONE, SLOTS, STATIONS, TARGETS, localToUv, targetToPoster, uvToLocal } from '../src/ar/sceneLayout';
import { CLIPS, RabbitAnimator } from '../src/rabbit/clips';
import { PART_IDS, makePose, rabbitSvg } from '../src/rabbit/rig';

describe('포스터 좌표계', () => {
  it('A1 비율과 좌표 왕복', () => {
    expect(H).toBeCloseTo(841 / 594, 6);
    expect(POSTER.widthM).toBe(0.594);
    expect(uvToLocal(0, 0)).toEqual([-0.5, H / 2]);
    expect(uvToLocal(1, 1)).toEqual([0.5, -H / 2]);
    const [u, v] = localToUv(...uvToLocal(0.3, 0.7));
    expect(u).toBeCloseTo(0.3);
    expect(v).toBeCloseTo(0.7);
  });

  it('패널은 포스터 안에 있고 서로 겹치지 않는다', () => {
    const rects = [HEADER, ...HIGHLIGHT_IDS.map((id) => PANELS[id])];
    for (const r of rects) {
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1);
      expect(r.v1).toBeLessThanOrEqual(1);
      expect(r.u1).toBeGreaterThan(r.u0);
      expect(r.v1).toBeGreaterThan(r.v0);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlap = a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;
        expect(overlap, `패널 ${i}/${j} 겹침`).toBe(false);
      }
  });

  it('3D 소품 자리는 자기 패널 안에, QR 자리는 결론 패널 안에 있다', () => {
    const inside = (s: { u0: number; v0: number; u1: number; v1: number }, p: typeof s) => s.u0 >= p.u0 && s.u1 <= p.u1 && s.v0 >= p.v0 && s.v1 <= p.v1;
    expect(inside(SLOTS.chamber, PANELS.methods)).toBe(true);
    expect(inside(SLOTS.thermometers, PANELS.results_thermal_continuous)).toBe(true);
    expect(inside(SLOTS.cyclicChart, PANELS.results_thermal_cyclic)).toBe(true);
    expect(inside(SLOTS.etchBars, PANELS.results_etch_rate)).toBe(true);
    expect(inside(SLOTS.mountBars, PANELS.results_mounting)).toBe(true);
    expect(inside(SLOTS.cuBars, PANELS.results_cu_profile)).toBe(true);
    expect(inside(SLOTS.moStack, PANELS.results_mo)).toBe(true);
    expect(inside(QR_ZONE, PANELS.conclusions)).toBe(true);
  });

  it('모든 장면에 토끼가 설 자리가 있다', () => {
    for (const s of scenes) expect(STATIONS[s.id], s.id).toBeDefined();
  });
});

describe('타깃 → 포스터 변환', () => {
  it('전체 타깃은 항등 변환', () => {
    const t = targetToPoster(TARGETS[0]);
    expect(t.scale).toBe(1);
    for (const v of t.position) expect(v).toBeCloseTo(0, 12);
  });

  it('부분 타깃의 중심은 포스터 좌표에서 crop 중심과 일치한다', () => {
    for (const t of TARGETS) {
      const { position, scale } = targetToPoster(t);
      // 앵커 원점(타깃 중심)을 포스터 좌표로: p_poster = (p_anchor - position) / scale
      const cx = (0 - position[0]) / scale;
      const cy = (0 - position[1]) / scale;
      const [ex, ey] = uvToLocal((t.crop.u0 + t.crop.u1) / 2, (t.crop.v0 + t.crop.v1) / 2);
      expect(cx).toBeCloseTo(ex, 9);
      expect(cy).toBeCloseTo(ey, 9);
      // 앵커 단위 1(타깃 폭)은 포스터 단위로 crop 폭
      expect(1 / scale).toBeCloseTo(t.crop.u1 - t.crop.u0, 9);
    }
  });

  it('QR 스티커가 붙는 결론 띠는 아래쪽 타깃에서 빠져 있다', () => {
    const lower = TARGETS.find((t) => t.id === 'lower')!;
    expect(lower.crop.v1).toBeLessThan(0.93);
  });
});

describe('토끼 리그', () => {
  it('모든 클립이 정의돼 있고, 포즈가 유한한 값만 낸다', () => {
    for (const id of RABBIT_CLIPS) {
      const def = CLIPS[id];
      expect(def.duration).toBeGreaterThan(0);
      for (const side of [1, -1] as const)
        for (let t = 0; t <= def.duration; t += def.duration / 12) {
          const p = RabbitAnimator.still(id, t, side);
          for (const part of PART_IDS) for (const v of Object.values(p.parts[part])) expect(Number.isFinite(v)).toBe(true);
        }
    }
  });

  it('애니메이터가 클립을 섞어 재생해도 값이 튀지 않는다', () => {
    const a = new RabbitAnimator();
    for (const id of RABBIT_CLIPS) {
      a.play(id);
      for (let i = 0; i < 90; i++) {
        const p = a.update(1 / 30);
        expect(Math.abs(p.parts.root.y)).toBeLessThan(80);
        expect(Math.abs(p.parts.earL.r)).toBeLessThan(60);
      }
    }
  });

  it('기준형 SVG 출력은 결정적이다(같은 원본 → 같은 그림)', () => {
    const a = rabbitSvg(makePose());
    expect(a).toBe(rabbitSvg(makePose()));
    expect(a).toContain('id="earL"');
    expect(a).toContain('id="tail"');
  });
});
