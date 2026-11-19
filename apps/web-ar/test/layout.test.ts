import { describe, expect, it } from 'vitest';
import { RABBIT_CLIPS } from '@rabbit/shared';
import { sceneScripts, scenes } from '@rabbit/content';
import { CHART, GUIDE, H, PAGE, POSTER, READ_VIEW, TARGETS, localToUv, targetToPoster, uvToLocal } from '../src/ar/sceneLayout';
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

  it('슬라이드의 구역은 포스터 안에 있고 위에서 아래로 겹치지 않게 놓인다', () => {
    const order = [PAGE.top, PAGE.title, PAGE.lead, PAGE.hero, PAGE.cards, PAGE.key, PAGE.progress];
    for (const r of order) {
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1);
      expect(r.v1).toBeLessThanOrEqual(1);
      expect(r.u1).toBeGreaterThan(r.u0);
      expect(r.v1).toBeGreaterThan(r.v0);
    }
    for (let i = 1; i < order.length; i++) expect(order[i].v0, `구역 ${i}`).toBeGreaterThanOrEqual(order[i - 1].v1);
  });

  it('그래프 자리는 HERO 안에 있고, 안내 토끼는 한 줄 정리·진행 표시와 겹치지 않는 오른쪽 아래에 선다', () => {
    expect(CHART.u0).toBeGreaterThanOrEqual(PAGE.hero.u0);
    expect(CHART.u1).toBeLessThanOrEqual(PAGE.hero.u1);
    expect(CHART.v0).toBeGreaterThanOrEqual(PAGE.hero.v0);
    expect(CHART.v1).toBeLessThanOrEqual(PAGE.hero.v1);
    expect(GUIDE.u).toBeGreaterThan(PAGE.key.u1);
    expect(GUIDE.v).toBeGreaterThan(PAGE.cards.v1);
  });

  it('장면은 기초 → 장비 → 결과 순서로 이어진다', () => {
    expect(sceneScripts.map((s) => s.id)).toEqual(scenes.map((s) => s.id));
    const parts = sceneScripts.map((s) => s.part);
    for (let i = 1; i < parts.length; i++) expect(parts[i]).toBeGreaterThanOrEqual(parts[i - 1]);
    // ICP·CCP 같은 장비 원리는 이 연구의 장비(ICP-RIE)보다 먼저 설명한다
    const idx = (id: string) => scenes.findIndex((s) => s.id === id);
    expect(idx('plasma_state')).toBeLessThan(idx('ccp_icp'));
    expect(idx('ccp_icp')).toBeLessThan(idx('plasma_basics'));
    expect(idx('heat_path')).toBeLessThan(idx('continuous_heat'));
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

describe('진짜 포스터 읽기', () => {
  it('해설 슬라이드가 끝난 뒤 원본 → 번역 → 구역별 읽기 순서로 이어진다', () => {
    const ids = scenes.map((x) => x.id);
    const read = ids.slice(ids.indexOf('conclusion') + 1);
    expect(read).toEqual(Object.keys(READ_VIEW));
    expect(READ_VIEW[read[0]].tex).toBe('original');
    for (const id of read.slice(1)) expect(READ_VIEW[id].tex).toBe('ko');
    for (const id of read) expect(sceneScripts.find((x) => x.id === id)?.part).toBe(4);
  });
  it('짚는 구역은 포스터 안에 있고 위에서 아래로 겹치지 않게 내려간다', () => {
    const rects = Object.values(READ_VIEW).flatMap((v) => (v.focus ? [v.focus] : []));
    expect(rects.length).toBe(5);
    rects.forEach((r, i) => {
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1);
      expect(r.v1).toBeGreaterThan(r.v0);
      expect(r.v1).toBeLessThanOrEqual(1);
      if (i > 0) expect(r.v0).toBeGreaterThanOrEqual(rects[i - 1].v1 - 1e-9);
    });
  });
});
