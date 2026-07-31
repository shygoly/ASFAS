#!/usr/bin/env node
// negative-verify-registry.mjs — check-registry / check-no-business-terms 的负向验证（VC-7 / VC-8）
//
// 未经负向验证的校验器不计入一致性证据（FR-3）。
// 两个检查维度各注入一条违规：注入 → 须红且消息命中 → 回滚 → 须绿。
// 注入目标：projects/registry.json（REG 维度）+ factory/ 文件（FNT 维度）。
//
// 用法：node spec/negative-verify-registry.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', 'projects', 'registry.json');
const FACTORY_TARGET = join(HERE, '..', 'factory', 'verifiers', 'lib', 'compare.mjs'); // 注入 FNT 的目标文件

const run = (checker) => {
  try { execFileSync('node', [checker], { encoding: 'utf8', stdio: 'pipe' }); return { red: false, out: '' }; }
  catch (e) { return { red: true, out: (e.stdout ?? '') + (e.stderr ?? '') }; }
};

// ── REG 维度：清空 C2 必需字段 action_levels 的值 → REG-2 红 ──
// 用"改空值"而非"删行"：删行会破坏 JSON 结构导致解析失败（走不到 REG-2 分支）。
const regCase = {
  dim: 'REG-2 C2 缺必需字段',
  file: REGISTRY,
  mutate: (s) => s.replace(/"action_levels":\s*"[^"]*"/, '"action_levels": ""'),
};

// ── FNT 维度：在 factory/ 文件注入项目业务术语 → FNT-2 红 ──────
// 注入一个 business_terms 里的真实标识符（audit_reviews）到 compare.mjs 注释。
const fntCase = {
  dim: 'FNT-2 业务术语命中',
  file: FACTORY_TARGET,
  mutate: (s) => s.replace('// compare.mjs', '// compare.mjs（负向注入：audit_reviews 不该出现在工厂层）'),
};

const CHECKERS = {
  [REGISTRY]: join(HERE, 'check-registry.mjs'),
  [FACTORY_TARGET]: join(HERE, 'check-no-business-terms.mjs'),
};

// 前置：两个校验器基线都须绿（FINV-8）
for (const checker of Object.values(CHECKERS)) {
  if (run(checker).red) {
    console.error(`✗ 基线不绿（${checker}），负向验证无法进行（FINV-8）`);
    process.exit(1);
  }
}

let failed = 0;
const cases = [[regCase, CHECKERS[REGISTRY]], [fntCase, CHECKERS[FACTORY_TARGET]]];
console.log('负向验证（registry）—— 每条维度：注入 → 须红且消息命中 → 回滚 → 须绿\n');

for (const [{ dim, file, mutate }, checker] of cases) {
  const original = readFileSync(file, 'utf8');
  const mutated = mutate(original);
  if (mutated === original) {
    console.error(`✗ ${dim}：注入未生效（锚点已变，用例需更新）—— 不得静默跳过`);
    failed++; continue;
  }
  writeFileSync(file, mutated);
  const r = run(checker);
  writeFileSync(file, original);
  const back = run(checker);

  const tag = dim.split(/\s/)[0];
  if (!r.red) { console.error(`✗ ${dim}：注入违规后仍为绿 —— 假绿`); failed++; }
  else if (!r.out.includes(tag)) { console.error(`✗ ${dim}：报红但消息未命中维度 ${tag}`); failed++; }
  else if (back.red) { console.error(`✗ ${dim}：回滚后仍红 —— 注入未完全回滚`); failed++; }
  else console.log(`  ✓ ${dim}：注入 → 红（消息命中）· 回滚 → 绿`);
}

console.log('━'.repeat(60));
if (failed) { console.error(`✗ 负向验证（registry）：${failed}/${cases.length} 项未通过`); process.exit(1); }
console.log(`✓ 负向验证（registry）：${cases.length}/${cases.length} 条用例全部通过（VC-8 · 2 条检查维度）`);
