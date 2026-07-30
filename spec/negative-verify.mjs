#!/usr/bin/env node
// negative-verify.mjs — check-asfas-doc.mjs 的负向验证（VC-7 / VC-8）
// 对每条检查维度：注入违规 → 须红且消息指出维度 → 回滚 → 须绿。
// 注入发生在工作区（VC-5），不提交。

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = join(HERE, 'ASFAS.html');
const CHECKER = join(HERE, 'check-asfas-doc.mjs');
const original = readFileSync(DOC, 'utf8');

const cases = [
  ['A 章节连续', (s) => s.replace('id="ch30"', 'id="ch30x"')],
  ['B rid 唯一/连续', (s) => s.replace('class="rid">MS-20<', 'class="rid">MS-19<')],
  ['C 引用可解析', (s) => s.replace('href="#ch25">§25</a>', 'href="#ch999">§25</a>')],
  ['D 附录 B 数量', (s) => s.replace('<td>Part III · <a href="#apxB">附录 B</a></td><td>42</td>', '<td>Part III</td><td>41</td>')],
  ['E CP 连续', (s) => s.replace('<code>CP-25</code>', '<code>CP-99</code>')],
  ['F SVG 非法元素', (s) => s.replace('<text x="45" y="25" class="actor" text-anchor="middle">人</text>', '<text x="45" y="25" class="actor" text-anchor="middle"><strong>人</strong></text>')],
  ['G 标签平衡', (s) => s.replace('</tbody>\n</table></div>', '</tbody>\n</table></div></div>')],
  ['H Part 结构', (s) => s.replace('id="partVI"', 'id="partVIx"')],
];

const run = () => {
  try { execFileSync('node', [CHECKER], { encoding: 'utf8' }); return { red: false, out: '' }; }
  catch (e) { return { red: true, out: (e.stdout || '') + (e.stderr || '') }; }
};

let failed = 0;
console.log('负向验证 —— 每条维度：注入 → 须红 → 回滚 → 须绿\n');

// 前置：基线必须绿，否则负向验证无意义（FINV-8）
if (run().red) { console.error('✗ 基线不绿，负向验证无法进行'); process.exit(1); }

for (const [dim, mutate] of cases) {
  const mutated = mutate(original);
  if (mutated === original) { console.error(`✗ ${dim}：注入未生效（锚点已变，用例需更新）`); failed++; continue; }
  writeFileSync(DOC, mutated);
  const r = run();
  writeFileSync(DOC, original);
  const back = run();

  const tag = dim.split(' ')[0];
  const named = r.out.includes(`✗ ${tag} `);
  if (!r.red) { console.error(`✗ ${dim}：注入违规后仍为绿 —— 假绿`); failed++; }
  else if (!named) { console.error(`✗ ${dim}：报红但未指出该维度（消息须定位问题，§25.3）`); failed++; }
  else if (back.red) { console.error(`✗ ${dim}：回滚后仍红 —— 校验器有状态或注入未完全回滚`); failed++; }
  else console.log(`  ✓ ${dim}：注入 → 红（消息命中）· 回滚 → 绿`);
}

console.log('━'.repeat(60));
if (failed) { console.error(`✗ 负向验证：${failed}/${cases.length} 项未通过`); process.exit(1); }
console.log(`✓ 负向验证：${cases.length}/${cases.length} 条检查维度全部通过（VC-8）`);
