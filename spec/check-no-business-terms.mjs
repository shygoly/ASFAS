#!/usr/bin/env node
// check-no-business-terms.mjs — 工厂层业务术语零命中校验（FINV-4 / CP-10）
//
// FINV-4（§7.2）：Layer 2 MUST 只依赖元语的 schema，MUST NOT 依赖任何具体项目的
//   元语内容。在工厂代码库中 grep 任一项目的业务术语，命中数 MUST 为 0（测试夹具除外）。
// CP-10（附录 A.1）：工厂层不含项目业务术语 —— grep：命中为 0（夹具除外）。
//
// ## 规范留白处的工程约定
//   规范未定义"业务术语"判据（纯人工）也未定义词源。本校验器词源来自 registry 各项目的
//   business_terms 清单（项目侧提供、项目维护，权威）。工厂 grep 它，命中 = 红。
//
// ## 扫描面与豁免（VC-6：显式声明）
//   扫描：factory/ 全部（§9.2"工厂层=核心资产，与项目无关"）。
//   豁免（"测试夹具除外"的实现约定，规范留白）：
//     - factory/verifiers/adapter.example.mjs —— 示例适配器是"项目要改写的模板"，
//       其中的 pgTable/pgEnum 是通用技术名（非业务术语），且整文件设计为被覆盖；
//     - 本校验器与 check-registry.mjs 自身 —— 它们会字面提及 business_terms 等词。
//   spec/ASFAS.html 按设计不含业务术语（FR-5 约束），不在扫描面内（叙述举例属豁免）。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.argv.includes('--fix')) {
  console.error('✗ VC-2：治理只诊断、不自动改。本校验器不提供 --fix。');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(HERE, '..');
const REGISTRY = join(FACTORY, 'projects', 'registry.json');
const SCAN_DIR = join(FACTORY, 'factory');
// 豁免文件（相对 SCAN_DIR）：测试夹具约定
const EXEMPT = new Set(['verifiers/adapter.example.mjs']);

const problems = [];
const ok = [];
const warns = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);
const warn = (m) => warns.push(m);

// ── 从 registry 收集各项目的业务术语清单 ────────────────────
let termsByProject = new Map();
if (existsSync(REGISTRY)) {
  let entries;
  try { entries = JSON.parse(readFileSync(REGISTRY, 'utf8')); } catch (e) {
    fail(`projects/registry.json 解析失败：${e.message}`);
    report(); process.exit(1);
  }
  for (const e of entries) {
    const terms = e.business_terms;
    if (!terms || !Array.isArray(terms) || terms.length === 0) {
      // 无清单不算红（项目可尚未提供）—— 可见提示，FINV-4 对该项目退化为人工守护
      warn(`FNT-1 ${e.id ?? '?'}: 无 business_terms 清单 —— FINV-4 对该项目退化为人工守护`);
      continue;
    }
    termsByProject.set(e.id, terms);
  }
} else {
  console.log('⊘ projects/registry.json 不存在 —— 无项目可 grep（FINV-4 暂为人工守护）');
  process.exit(0);
}

if (termsByProject.size === 0) {
  console.log('⊘ 无项目提供 business_terms —— FINV-4 暂为人工守护');
  process.exit(0);
}

// ── 收集 factory/ 扫描面文件（排除豁免）──────────────────────
function walk(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, r));
    else if (!EXEMPT.has(r)) out.push(full);
  }
  return out;
}
const files = walk(SCAN_DIR);

// ── grep：每个项目的术语 × 每个文件 ──────────────────────────
let totalHits = 0;
for (const [projectId, terms] of termsByProject) {
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const term of terms) {
      // 词边界匹配（避免子串误伤）；术语可能是 snake_case 标识符或中文短语
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`);
      const rel = file.replace(FACTORY + '/', '');
      if (re.test(text)) hits.push({ file: rel, term });
    }
  }
  if (hits.length) {
    totalHits += hits.length;
    const byFile = new Map();
    for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? []).concat(h.term));
    fail(`FNT-2 ${projectId}: factory/ 命中 ${hits.length} 处业务术语（FINV-4：MUST 为 0）`);
    for (const [file, ts] of byFile)
      fail(`     ${file}: ${[...new Set(ts)].join(', ')}`);
  } else {
    pass(`FNT ${projectId}: factory/ 业务术语零命中（FINV-4）`);
  }
}

function report() {
  for (const m of ok) console.log(`  ✓ ${m}`);
  for (const w of warns) console.log(`  ⚠ ${w}`);
  for (const m of problems) console.error(`  ✗ ${m}`);
  console.log('━'.repeat(60));
  if (problems.length) {
    console.error(`✗ check-no-business-terms: ${problems.length} 项失败` + (warns.length ? `，${warns.length} 项警告` : ''));
    process.exit(1);
  }
  console.log(`✓ check-no-business-terms: 全部通过` + (warns.length ? `（${warns.length} 项警告，不影响退出码）` : ''));
}
report();
