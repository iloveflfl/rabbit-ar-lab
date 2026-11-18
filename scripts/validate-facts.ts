/**
 * 연구 수치 보호 검사. 포스터의 핵심 숫자가 poster_facts.json 에 그대로 있는지,
 * 인계 패키지 원본과 같은지 확인한다.   npm run validate:facts
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const path = resolve(root, 'packages/educational-content/data/poster_facts.json');
const facts = JSON.parse(readFileSync(path, 'utf8'));
const f = (id: string) => facts.facts.find((x: { id: string }) => x.id === id);
let bad = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}`);
  if (!ok) bad++;
};

check('연속 120 s 시편 2.3→73°C', [f('sic_continuous_minus50').sample_initial_c, f('sic_continuous_minus50').sample_final_c], [2.3, 73]);
check('연속 120 s 홀더 3.2→98°C', [f('sic_continuous_minus50').holder_initial_c, f('sic_continuous_minus50').holder_final_c], [3.2, 98]);
check('반복 냉각 순서', f('sic_cyclic_minus50').sequence.map((s: { sample_c: number }) => s.sample_c), [11, 27, 14.5, 30, 16, 32]);
check('SiC 식각률', f('sic_etch_rate_setpoints').conditions.map((c: { etch_rate_nm_per_min: number }) => c.etch_rate_nm_per_min), [201, 75, 185]);
check('self-bias', f('sic_etch_rate_setpoints').conditions.map((c: { self_bias_v: number }) => c.self_bias_v), [116, 103, 115]);
check('받침별 시편 온도', f('sic_mounting_comparison').conditions.map((c: { sample_c: number }) => c.sample_c), [73, 92, 78, 76]);
check('Cu 단차', f('cu_profile_postprocessing').comparisons.map((c: { after_pr_strip_angstrom: number; after_di_hcl_angstrom: number }) => [c.after_pr_strip_angstrom, c.after_di_hcl_angstrom]), [[10999, 3662], [14442, 11822], [11090, 10808]]);
check('Mo 참고', f('mo_reference_etch').approx_etch_rate_nm_per_min, 95);
check('Si/유리(별도 실험)', [f('semester1_si_glass_benchmark').etch_rate_nm_per_min.si, f('semester1_si_glass_benchmark').etch_rate_nm_per_min.glass], [930.65, 155.82]);

const original = resolve(root, '_handoff/RabbitAR_Codex_Handoff_v2/data/poster_facts.json');
if (existsSync(original)) check('인계 원본과 동일', readFileSync(path, 'utf8') === readFileSync(original, 'utf8'), true);
else console.log('SKIP 인계 원본 비교 (_handoff 없음)');

console.log(bad === 0 ? '\n수치 검증 통과' : `\n수치 검증 실패 (${bad})`);
process.exit(bad === 0 ? 0 : 1);
