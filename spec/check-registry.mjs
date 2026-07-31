#!/usr/bin/env node
// check-registry.mjs — 项目注册表等级一致性校验（FR-16 / FINV-3）
//
// FR-16（§13.2）：注册表条目声明的 conformance MUST 可由工厂验证，
//   MUST NOT 仅为自我声明。工厂 MUST 能通过执行 verify_cmd 与检查
//   必需字段的存在性来确认等级；声明等级高于可验证等级 = 红。
// FINV-3（§6.2）：等级 MUST NOT 跳跃。声明 Cn 时 C0..Cn 全部要求须满足并可验证。
//
// ## 规范留白处的工程约定（实现扩展字段）
//   §13.2 字段表只定义了 id/path/conformance/meta_languages/verify_cmd/
//   action_levels/lineage_dir 七个字段。本校验器依赖两个**实现扩展字段**：
//   - local_path：项目在本机的克隆路径（可选）。有则执行 verify_cmd 验证（FR-16 的"执行"）；
//     无则按 VC-12 可见跳过（警告），MUST NOT 静默通过。规范对 path 为远端 URL 时
//     如何执行 verify_cmd 留白，本字段是让它本地可达的手段。
//   - business_terms：项目业务术语清单（可选），供 FINV-4 校验器 grep。规范未定义术语来源。
//
// ## 等级判据（§6.2 + 附录 A 分区 CP + §13.2 条件字段）
//   C0：六本核心元语齐备（registry 无字段直接表达，由 meta_languages 列清单近似）。
//   C1：C0 + verify_cmd 存在且执行返回 0（本机有 local_path 时）。
//   C2：C1 + action_levels + lineage_dir 字段存在。
//   本校验器做**字段存在性 + 可达时 verify_cmd 执行**两件事；
//   附录 A 的逐项 CP（如 CP-34 护栏表非空）属项目侧自校验，不在此重复。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

if (process.argv.includes('--fix')) {
  console.error('✗ VC-2：治理只诊断、不自动改。本校验器不提供 --fix。');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', 'projects', 'registry.json');
const FACTORY_ROOT = join(HERE, '..');

const problems = [];
const ok = [];
const warns = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);
const warn = (m) => warns.push(m);

// 各等级必需的 registry 条件字段（§13.2，累积）
const REQUIRED_BY_LEVEL = {
  C1: ['verify_cmd'],
  C2: ['verify_cmd', 'action_levels', 'lineage_dir'],
};
// 所有等级都无条件必需的字段
const REQUIRED_ALWAYS = ['id', 'path', 'conformance', 'meta_languages'];

if (!existsSync(REGISTRY)) {
  // 无 registry 不算红（工厂可能尚未治理任何项目，FP-6）—— 但可见提示
  console.log('⊘ projects/registry.json 不存在 —— 工厂尚未治理任何项目（FP-6）');
  process.exit(0);
}

let entries;
try {
  entries = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (e) {
  console.error(`✗ projects/registry.json 解析失败：${e.message}`);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  console.error('✗ projects/registry.json 顶层须为数组');
  process.exit(1);
}

const LEVELS = ['C0', 'C1', 'C2', 'C3', 'C4'];
/** 判定字段集合（累积）：声明等级 Cn 则需 C0..Cn 全部条件字段 */
const fieldsNeeded = (conformance) => {
  const idx = LEVELS.indexOf(conformance);
  if (idx < 0) return null;       // 非法等级
  const acc = new Set(REQUIRED_ALWAYS);
  for (let i = 1; i <= idx; i++) Object.values(REQUIRED_BY_LEVEL).flat().forEach((f) => acc.add(f));
  // 精确到声明的等级：只取 ≤ 该等级的字段
  const exact = new Set(REQUIRED_ALWAYS);
  for (const lvl of LEVELS.slice(1, idx + 1)) {
    if (REQUIRED_BY_LEVEL[lvl]) REQUIRED_BY_LEVEL[lvl].forEach((f) => exact.add(f));
  }
  return exact;
};

for (const e of entries) {
  const id = e.id ?? '(无 id)';
  if (!LEVELS.includes(e.conformance)) {
    fail(`REG-1 ${id}: conformance "${e.conformance}" 非法（须为 C0..C4）`);
    continue;
  }

  // ── 必需字段存在性（FR-16"检查必需字段的存在性"）──────────
  const needed = fieldsNeeded(e.conformance);
  const missing = [...needed].filter((f) => !e[f] || (Array.isArray(e[f]) && e[f].length === 0));
  if (missing.length) {
    fail(`REG-2 ${id}: 声明 ${e.conformance} 但缺必需字段 ${missing.join(', ')}（FR-16 / §13.2）`);
  } else {
    pass(`REG ${id}: ${e.conformance} 必需字段齐备`);
  }

  // ── verify_cmd 可达性验证（FR-16"执行 verify_cmd"）─────────
  if (e.verify_cmd && e.local_path) {
    const projectRoot = resolve(FACTORY_ROOT, e.local_path);
    if (!existsSync(projectRoot)) {
      warn(`REG-3 ${id}: local_path "${e.local_path}" 在本机不存在 —— verify_cmd 未执行（可见跳过）`);
    } else {
      try {
        execFileSync(e.verify_cmd[0], e.verify_cmd.slice(1), { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
        pass(`REG ${id}: verify_cmd 在本地执行通过（FR-16）`);
      } catch (err) {
        const out = (err.stdout ?? '') + (err.stderr ?? '');
        fail(`REG-4 ${id}: verify_cmd 在本地执行失败（FR-16：声明等级高于可验证等级 = 红）`);
        if (out.trim()) fail(`     末尾输出：${out.trim().split('\n').slice(-3).join(' | ')}`);
      }
    }
  } else if (e.verify_cmd && !e.local_path) {
    // C1+ 声明了 verify_cmd 但无 local_path → 远端项目，工厂本机无法执行 → 可见跳过（VC-12）
    warn(`REG-3 ${id}: 无 local_path（path 为远端）—— verify_cmd 未执行（可见跳过，VC-12；规范留白）`);
  }
}

// ── 报告（与 check-asfas-doc.mjs 风格一致）──────────────────
for (const m of ok) console.log(`  ✓ ${m}`);
for (const w of warns) console.log(`  ⚠ ${w}`);
for (const m of problems) console.error(`  ✗ ${m}`);
console.log('━'.repeat(60));
if (problems.length) {
  console.error(`✗ check-registry: ${problems.length} 项失败` + (warns.length ? `，${warns.length} 项警告` : ''));
  process.exit(1);
}
console.log(`✓ check-registry: 全部通过` + (warns.length ? `（${warns.length} 项警告，不影响退出码）` : ''));
