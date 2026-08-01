#!/usr/bin/env node
// check-projects.mjs — 编排面项目维度校验（决策 `D-PROJ-1` · IN-14 / FINV-3 / FINV-4 / AG-14）
//
// ## PJ-2 是这组里最要紧的一条
//   `IN-14`：跨项目共享 MUST NOT 存在，工厂层 MAY 跨项目聚合度量，但**聚合 MUST NOT 形成跨项目的写路径**。
//   血缘是四类状态里唯一必须落项目仓的（`§50.2` 要求与代码同版本可追溯）。
//   若血缘落点算出来仍在工厂仓内，工厂就成了所有项目状态的共同写入方——正是 IN-14 禁止的形态。
//
// ## 扫描面（VC-6）
//   projects/registry.json 全部条目 · factory/orchestration/projects.mjs 源码

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute } from 'node:path';
import {
  resolveProject, assertDispatchAllowed, assertMergeAllowed, lineageRootFor, eventRootFor,
  isWriteLevel, MIN_CONFORMANCE_FOR_DISPATCH,
} from '../factory/orchestration/projects.mjs';
import { parseActionLevels, CANONICAL_HEADER, CANONICAL_LEVELS } from '../factory/orchestration/grading.mjs';

if (process.argv.includes('--fix')) {
  console.error('✗ VC-2：治理只诊断、不自动改。本校验器不提供 --fix。');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'factory', 'orchestration', 'projects.mjs');

const problems = [];
const ok = [];
const warns = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);
const warn = (m) => warns.push(m);

const registry = JSON.parse(readFileSync(join(ROOT, 'projects', 'registry.json'), 'utf8'));
if (registry.length === 0) { console.log('⊘ registry 为空 —— 无项目可校验（FP-6）'); process.exit(0); }

const LEVELS = ['C0', 'C1', 'C2', 'C3', 'C4'];
const inFactory = (p) => { const r = relative(ROOT, p); return r && !r.startsWith('..') && !isAbsolute(r); };

// ── PJ-1 门槛常量 == 规范要求（FINV-3）────────────────────────
// **期望值在这里硬编码，MUST NOT 从被测代码 import。**
// 第一版就是从 projects.mjs import 了 MIN_CONFORMANCE_FOR_DISPATCH 再拿它算期望——
// 改常量时两边一起变，判定永远"一致"，是个自证式断言（tautology），负向验证当场抓到它没在守。
// 断言的两边必须来自不同的源：一边是实现，另一边是规范。
const REQUIRED_BY_SPEC = 'C2';   // §6.2 + FINV-3：编排面是 C3 能力，C3 = C2 + 编排面
{
  if (MIN_CONFORMANCE_FOR_DISPATCH !== REQUIRED_BY_SPEC) {
    fail(`PJ-1 编排面门槛被改为 ${MIN_CONFORMANCE_FOR_DISPATCH}，规范要求 ${REQUIRED_BY_SPEC}`);
    fail('     FINV-3：等级 MUST NOT 跳跃。在 C1 未达成时启用 C3 编排面 = 给一群智能体发放无护栏的写权限');
  } else {
    pass(`PJ-1 编排面门槛 ${MIN_CONFORMANCE_FOR_DISPATCH} == 规范要求（FINV-3）`);
  }
}

// ── PJ-2 两道门逐项判定（各自独立算期望）────────────────────
{
  const bad = [];

  // 先用**合成项目**覆盖象限。理由：真实 registry 里恰好没有"等级 ≥ C2 但无分级表"的组合，
  // 等级门总是先拦住无分级表的项目，归级门分支在真实数据下**不可达**——
  // 只测真实数据会留下一个看不见的盲区，负向验证当场证明了这一点。
  // 门是纯函数，就该用合成输入把象限走全。
  const face = (paths) => ({ id: 'synthetic', paths, policy: '' });
  const GRADING = { L0: face([]), L1: face(['x/**']), L2: face(['y/**']), L3: face([]) };
  const GRADING_NO_L1 = { ...GRADING, L1: face([]) };   // 表解析了但 L1 路径面为空（D-GRADE-1 ⑤）

  const QUADRANTS = [
    { conformance: 'C2', grading: GRADING, level: 'L1', expect: true },
    { conformance: 'C2', grading: null, level: 'L1', expect: false },        // 只有合成数据能走到这格
    { conformance: 'C1', grading: GRADING, level: 'L1', expect: false },
    { conformance: 'C1', grading: null, level: 'L1', expect: false },
    // D-GRADE-1 ⑤：表在、但该等级无路径面 == 没有可归级的东西，与"表不在"等效
    { conformance: 'C2', grading: GRADING_NO_L1, level: 'L1', expect: false },
    // D-RELEASE-1：L2 派发允许（先干后放，隔离副本执行）；合并生效前由合并门另判（assertMergeAllowed）
    { conformance: 'C2', grading: GRADING, level: 'L2', expect: true },
    { conformance: 'C2', grading: null, level: 'L2', expect: false },        // 无分级表 → AG-14 拒
    { conformance: 'C2', grading: GRADING, level: 'L0', expect: true },      // 只读永不过写类门
  ];
  for (const q of QUADRANTS) {
    const synthetic = {
      id: `synthetic-${q.conformance}-${q.level}`, conformance: q.conformance,
      grading: q.grading, gradingError: q.grading ? null : '合成用例：无分级表',
      localPath: null, lineageDir: null,
    };
    let allowed = true;
    try { assertDispatchAllowed(synthetic, q.level); } catch { allowed = false; }
    if (allowed !== q.expect) {
      // 两道门的期望**各自独立算**，与真实条目那段同构——合并后无法分辨是哪道门失效
      const isWrite = q.level !== 'L0';
      const lvlGate = !isWrite || LEVELS.indexOf(q.conformance) >= LEVELS.indexOf(REQUIRED_BY_SPEC);
      const grdGate = !isWrite || Boolean(q.grading && q.grading[q.level]?.paths.length);
      bad.push(`合成用例 ${q.conformance}/${q.level}/分级表${q.grading ? '有' : '无'}：`
        + `门判定 ${allowed ? '放行' : '拒绝'}，期望 ${q.expect ? '放行' : '拒绝'}`
        + `（等级门应${lvlGate ? '过' : '拒'} · 归级门应${grdGate ? '过' : '拒'}）`);
    }
  }

  for (const e of registry) {
    const p = resolveProject(ROOT, e.id);
    // 期望分层独立算，不合并——合并后无法分辨是哪道门失效
    const passLevelGate = LEVELS.indexOf(p.conformance) >= LEVELS.indexOf(REQUIRED_BY_SPEC);
    const passGradingGate = Boolean(p.grading && p.grading.L1 && p.grading.L1.paths.length > 0);
    let allowed = true; let why = '';
    try { assertDispatchAllowed(p, 'L1'); } catch (err) { allowed = false; why = err.message; }
    const expected = passLevelGate && passGradingGate;
    if (allowed !== expected) {
      bad.push(`${e.id}（${p.conformance}，分级表:${passGradingGate ? '可用' : '不可用'}）：`
        + `门判定 ${allowed ? '放行' : '拒绝'}，期望 ${expected ? '放行' : '拒绝'}`
        + `（等级门应${passLevelGate ? '过' : '拒'} · 归级门应${passGradingGate ? '过' : '拒'}）${why ? ` — 实际：${why.slice(0, 60)}` : ''}`);
    }
    // L0 只读永远放行——否则连研究工作流都跑不了，编排面对未达 C2 的项目就完全无用
    let l0 = true;
    try { assertDispatchAllowed(p, 'L0'); } catch { l0 = false; }
    if (!l0) bad.push(`${e.id}：L0 只读活动被拒 —— 只读不应过写类门`);
  }
  if (bad.length) { fail('PJ-2 两道门判定与期望不符：'); bad.forEach((b) => fail(`     ${b}`)); }
  else pass(`PJ-2 ${registry.length} 个项目的两道门判定与独立算出的期望一致（FINV-3 / AG-14）`);
}

// ── PJ-3 血缘落点 MUST 在项目侧，不得落在工厂仓内（IN-14 / §50.2）──
{
  const bad = [];
  for (const e of registry) {
    const p = resolveProject(ROOT, e.id);
    if (!p.localPath) { warn(`PJ-3 ${e.id} 无 local_path，血缘落点无法校验（可见跳过）`); continue; }
    if (!existsSync(p.localPath)) { warn(`PJ-3 ${e.id} 的 local_path 在本机不存在，落点未校验（可见跳过）`); continue; }
    const dir = lineageRootFor(p);
    if (inFactory(dir)) bad.push(`${e.id}：血缘落点 ${dir} 在**工厂仓内** —— 工厂成为所有项目状态的共同写入方（IN-14）`);
    if (!dir.startsWith(p.localPath)) bad.push(`${e.id}：血缘落点 ${dir} 不在项目 local_path 子树内`);
  }
  if (bad.length) { fail('PJ-3 血缘落点违反跨项目隔离：'); bad.forEach((b) => fail(`     ${b}`)); }
  else pass('PJ-3 全部项目的血缘落点均在各自 local_path 子树内，且不在工厂仓内（IN-14 / §50.2）');
}

// ── PJ-4 事件落点：工厂侧、按 project_id 分目录（D-PROJ-1 落地限定）──
{
  const bad = [];
  const seen = new Set();
  for (const e of registry) {
    const dir = eventRootFor(ROOT, e.id);
    if (!inFactory(dir)) bad.push(`${e.id}：事件落点 ${dir} 不在工厂仓内`);
    if (!dir.endsWith(e.id)) bad.push(`${e.id}：事件落点未按 project_id 分目录（${dir}）`);
    if (seen.has(dir)) bad.push(`${e.id}：事件落点与其他项目冲突 —— 目录不唯一即形成跨项目共享`);
    seen.add(dir);
  }
  if (bad.length) { fail('PJ-4 事件落点不符：'); bad.forEach((b) => fail(`     ${b}`)); }
  else pass(`PJ-4 ${registry.length} 个项目的事件落点在工厂侧且按 project_id 唯一分目录`);
}

// ── PJ-5 FINV-4：编排面不得依赖任何具体项目 ────────────────
// 项目差异**只能**经 registry 字段与项目侧文件表达。源码里出现某个项目的 id，
// 就意味着工厂层认识了那个项目——换个项目就要改 factory/。
{
  const src = readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hits = registry.map((e) => e.id).filter((id) => new RegExp(`['"\`]${id}['"\`]|\\b${id}\\b`).test(src));
  if (hits.length) {
    fail(`PJ-5 projects.mjs 出现具体项目 id：${hits.join(', ')}（FINV-4：项目差异只能经 registry 字段表达）`);
  } else {
    pass(`PJ-5 projects.mjs 零具体项目 id 提及（FINV-4；已比对 registry 全部 ${registry.length} 个 id）`);
  }
}

// ── PJ-6 分级表解析契约（决策 D-GRADE-1 · 原 Q-5）──────────
// registry 的 action_levels 字段是一句**断言**："这个项目有一张可归级的分级表"。
// 只查字段在不在，守的是"有没有写过这个字段"，不是"断言是否属实"——
// 后者才是归级门的判定输入。字段在而表读不了，就是一条假断言。
{
  // 期望值在 spec 侧独立给出，MUST NOT 从被测代码 import 后再拿它算期望（PJ-1 那条自证式断言的教训）。
  const HEADER_BY_SPEC = ['等级', '范围（路径面）', '策略'];
  const LEVELS_BY_SPEC = ['L0-readonly', 'L1-low-write', 'L2-high-write', 'L3-forbidden'];
  const bad = [];

  if (CANONICAL_HEADER.join('|') !== HEADER_BY_SPEC.join('|')) {
    bad.push(`契约表头被改为 [${CANONICAL_HEADER.join(' | ')}]，D-GRADE-1 ③ 要求 [${HEADER_BY_SPEC.join(' | ')}]`);
  }
  if (CANONICAL_LEVELS.join('|') !== LEVELS_BY_SPEC.join('|')) {
    bad.push(`契约等级闭集被改为 ${CANONICAL_LEVELS.join(' / ')}，D-GRADE-1 ④ 要求 ${LEVELS_BY_SPEC.join(' / ')}`);
  }

  let checked = 0;
  for (const e of registry) {
    if (!e.action_levels) continue;                       // 未声明分级表 → 无断言可验
    const p = resolveProject(ROOT, e.id);
    if (!p.localPath || !existsSync(p.localPath)) {
      warn(`PJ-6 ${e.id} 的 local_path 在本机不存在，分级表未校验（可见跳过，VC-12）`);
      continue;
    }
    checked += 1;
    if (!p.grading) {
      bad.push(`${e.id}：registry 声明 action_levels，但分级表不可用 —— ${p.gradingError}`);
      continue;
    }
    // 可诊断性（判据 K3）：解析成功时四个等级都须在，L1/L2 路径面非空——
    // 解析器若在这里放水，归级门拿到的就是一张半真的表。
    const holes = LEVELS_BY_SPEC.filter((l) => !Object.values(p.grading).some((f) => f.id === l));
    if (holes.length) bad.push(`${e.id}：分级表解析结果缺等级 ${holes.join(', ')}`);
    for (const k of ['L1', 'L2']) {
      if (!p.grading[k]?.paths.length) bad.push(`${e.id}：分级表 ${k} 路径面为空却被判为可用`);
    }
  }

  // 解析失败 MUST 给出非空理由，否则门只能报"不知道为什么拒绝"（K3）。
  const nullParse = parseActionLevels('# 没有 §2 小节的文件\n');
  if (nullParse.levels !== null) bad.push('解析器对缺 §2 小节的文件返回了非 null 分级表（应 fail-closed）');
  else if (!nullParse.error) bad.push('解析器返回 levels=null 却无 error 理由（K3 失败可诊断不成立）');

  if (bad.length) { fail('PJ-6 分级表解析契约（D-GRADE-1）：'); bad.forEach((b) => fail(`     ${b}`)); }
  else pass(`PJ-6 分级表解析契约齐备：契约常量与规范一致，${checked} 个项目的分级表严格解析通过（D-GRADE-1）`);
}

// ── PJ-7 合并门判定（D-RELEASE-1：先干后放）──────────────
// L2 活动的实际改动集在合并生效前 MUST 已获路径级放行（IN-8 ③）。
// 用合成改动集 + 放行集把象限走全（门是纯函数，合成输入即可覆盖）：
//   ① L2 路径未放行 → 拒（fail-closed，AG-14 精神）
//   ② L2 路径已放行 → 过
//   ③ L3 路径 → 无条件拒（AG-15 短路，L3 无放行路径）
//   ④ 分级表不可用 → 拒（无法归级）
{
  const face = (paths) => ({ id: 'synthetic', paths, policy: '' });
  const GRADING = { L0: face([]), L1: face(['apps/**/*.spec.ts']), L2: face(['apps/connector/src/**']), L3: face(['**/migrations/**']) };
  const proj = { id: 'synthetic', conformance: 'C2', grading: GRADING, gradingError: null, localPath: null, lineageDir: null };
  const quadrants = [
    { changed: ['apps/connector/src/domain/x.ts'], released: [], expect: false, why: 'L2 未放行 → 拒' },
    { changed: ['apps/connector/src/domain/x.ts'], released: ['apps/connector/src/domain/x.ts'], expect: true, why: 'L2 已放行 → 过' },
    { changed: ['packages/db/migrations/001.sql'], released: ['packages/db/migrations/001.sql'], expect: false, why: 'L3 命中短路 → 拒（AG-15）' },
    { changed: ['apps/api/src/x.spec.ts'], released: [], expect: true, why: 'L1 不触发合并门' },
    { changed: ['unknown/path.ts'], released: [], expect: false, why: '未匹配路径 → AG-14 归 L2 → 拒' },
  ];
  const bad = [];
  for (const q of quadrants) {
    let ok = true;
    try { assertMergeAllowed(proj, q.changed, new Set(q.released)); } catch { ok = false; }
    if (ok !== q.expect) bad.push(`改动集 ${q.changed.join(',')} / 放行 ${q.released.join(',')}：门判定 ${ok ? '过' : '拒'}，期望 ${q.expect ? '过' : '拒'}（${q.why}）`);
  }
  const noGrading = { ...proj, grading: null, gradingError: '合成用例' };
  let ngOk = true;
  try { assertMergeAllowed(noGrading, ['apps/connector/src/domain/x.ts'], new Set()); } catch { ngOk = false; }
  if (ngOk) bad.push('分级表不可用时合并门放行 —— 应 fail-closed（AG-14）');
  if (bad.length) { fail('PJ-7 合并门（D-RELEASE-1）：'); bad.forEach((b) => fail(`     ${b}`)); }
  else pass(`PJ-7 合并门 ${quadrants.length + 1} 个象限判定正确（L2 须放行 · L3 短路 · 未匹配归 L2 · 表不可用拒）`);
}

// ── 报告 ───────────────────────────────────────────────────
for (const m of ok) console.log(`  ✓ ${m}`);
for (const w of warns) console.log(`  ⚠ ${w}`);
for (const m of problems) console.error(`  ✗ ${m}`);
console.log('━'.repeat(60));
if (problems.length) { console.error(`✗ check-projects: ${problems.length} 项失败` + (warns.length ? `，${warns.length} 项警告` : '')); process.exit(1); }
console.log('✓ check-projects: 全部通过' + (warns.length ? `（${warns.length} 项警告，不影响退出码）` : ''));
