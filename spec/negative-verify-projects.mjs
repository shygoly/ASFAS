#!/usr/bin/env node
// negative-verify-projects.mjs — check-projects 的负向验证（VC-7 / VC-8）
//
// 注入目标分两处：projects.mjs（PJ-1..PJ-5，两道门与落点）与 grading.mjs（PJ-6，分级表解析契约）。
// registry.json 只被读取（PJ-5 取项目 id），不作注入目标——「登记的等级是否属实」由
// check-registry 的 REG-4 守，两处重复守同一件事反而模糊边界。

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKER = join(HERE, 'check-projects.mjs');
const REGISTRY = join(ROOT, 'projects', 'registry.json');
const SRC = join(ROOT, 'factory', 'orchestration', 'projects.mjs');
const GRADING = join(ROOT, 'factory', 'orchestration', 'grading.mjs');

const run = () => {
  try { execFileSync('node', [CHECKER], { encoding: 'utf8', stdio: 'pipe' }); return { red: false, out: '' }; }
  catch (e) { return { red: true, out: (e.stdout ?? '') + (e.stderr ?? '') }; }
};

const CASES = [
  {
    dim: 'PJ-1 门槛常量被放宽',
    file: SRC,
    expect: '规范要求 C2',
    // 把编排面要求的最低等级从 C2 降到 C0 → C0/C1 项目也能派写类活动，与 FINV-3 冲突
    mutate: (s) => s.replace("export const MIN_CONFORMANCE_FOR_DISPATCH = 'C2';", "export const MIN_CONFORMANCE_FOR_DISPATCH = 'C0';"),
  },
  {
    dim: 'PJ-3 血缘落点被挪进工厂仓',
    file: SRC,
    expect: '在**工厂仓内**',
    mutate: (s) => s.replace(
      'return join(project.localPath, project.lineageDir ?? DEFAULT_LINEAGE_DIR);',
      "return join(process.cwd(), '.agent-runs', project.id);",
    ),
  },
  {
    dim: 'PJ-4 事件落点不按项目分目录',
    file: SRC,
    expect: '未按 project_id 分目录',
    mutate: (s) => s.replace(
      "return projectId ? join(factoryRoot, '.workflow-runs', projectId) : join(factoryRoot, '.workflow-runs');",
      "return join(factoryRoot, '.workflow-runs');",
    ),
  },
  {
    dim: 'PJ-5 编排面硬编码具体项目 id',
    file: SRC,
    expect: '出现具体项目 id',
    // 取 registry 第一个 id 注入——不写死项目名，注入器自己也遵守 FINV-4
    mutate: (s) => {
      const id = JSON.parse(readFileSync(REGISTRY, 'utf8'))[0].id;
      return s.replace('const order = (c) => LEVELS.indexOf(c);', `const order = (c) => LEVELS.indexOf(c);\nconst LEGACY = '${id}';`);
    },
  },
  {
    dim: 'PJ-2 归级门被跳过',
    file: SRC,
    expect: '归级门应拒',
    // 让归级门无条件放行 → 无 action_levels 的项目也能派写类活动 → 与独立算出的期望不符。
    //
    // 注意这里注入的**不是** registry 虚报等级：把无 action_levels 的项目谎报成 C2 时，
    // 归级门仍会拦住，系统行为正确，不构成违规。「登记的等级是否属实」由 check-registry 的
    // REG-4（执行 verify_cmd 验证）守，不在 PJ 的职责内——两处重复守同一件事反而模糊边界。
    // 注入点是**门的调用**而不是门内某个分支：把 `if (!project.grading)` 改成 `if (false)`
    // 只会让下一行在 null 上抛 TypeError，调用方照样 catch 成"拒绝"，判定不变——
    // 那样的注入测不到任何东西，看着像红其实是同一个结果。跳过整道门才是这个维度的真形态。
    mutate: (s) => s.replace(
      '  assertConformanceGate(project, actionLevel);\n  assertGradingGate(project, actionLevel);',
      '  assertConformanceGate(project, actionLevel);',
    ),
  },
  {
    dim: 'PJ-2 空路径面被判为可归级（D-GRADE-1 ⑤）',
    file: SRC,
    expect: '归级门应拒',
    // 表解析了但该等级没有任何路径面 —— 与"表不在"等效，放它过去就是拿一张半真的表发写权限
    mutate: (s) => s.replace(
      '  if (!face || face.paths.length === 0) {',
      '  if (false) {',
    ),
  },
  {
    dim: 'PJ-7 合并门放行未放行的 L2 改动集（D-RELEASE-1）',
    file: SRC,
    expect: '门判定 过，期望 拒',
    // D-RELEASE-1 先干后放：合并门 MUST 拒绝含未放行 L2 路径的改动集（PJ-7 象限①）。
    // 注入：把 releasedPaths.has(p) 改成恒 true，模拟"放行检查被跳过" → L2 未放行象限翻转。
    mutate: (s) => s.replace("if (level === 'L2' && !releasedPaths.has(p)) {", "if (level === 'L2' && !(releasedPaths.has(p) || true)) {"),
  },
  {
    dim: 'PJ-7 合并门放行 L3 路径（AG-15 短路）',
    file: SRC,
    expect: '门判定 过，期望 拒',
    // L3 命中短路（AG-15）：L3 无放行路径，合并门 MUST 拒绝（PJ-7 象限③）。
    // 注入：把 L3 判定改掉 → L3 象限翻转。
    mutate: (s) => s.replace("if (level === 'L3') {", "if (level === 'L3' && false) {"),
  },
  {
    dim: 'PJ-6 契约表头被改（D-GRADE-1 ③）',
    file: GRADING,
    expect: '契约表头被改为',
    mutate: (s) => s.replace(
      "export const CANONICAL_HEADER = Object.freeze(['等级', '范围（路径面）', '策略']);",
      "export const CANONICAL_HEADER = Object.freeze(['等级', '路径', '策略']);",
    ),
  },
  {
    dim: 'PJ-6 契约等级闭集被改（D-GRADE-1 ④）',
    file: GRADING,
    expect: '契约等级闭集被改为',
    mutate: (s) => s.replace(
      "'L0-readonly', 'L1-low-write', 'L2-high-write', 'L3-forbidden'",
      "'L0-readonly', 'L1-low-write', 'L2-high-write'",
    ),
  },
  {
    dim: 'PJ-6 解析器缺 §2 时 fail-open',
    file: GRADING,
    expect: '应 fail-closed',
    // 解析不出还返回一张（空）表 —— 门会拿它当"可归级"用，正是 AG-14 兜底被绕过的形态
    mutate: (s) => s.replace(
      "  if (md === null) return err('未找到 `## 2.` 小节（D-GRADE-1 ②：小节定位）');",
      '  if (md === null) return { levels: {}, error: null };',
    ),
  },
];

const baseline = run();
if (baseline.red) {
  console.error(`✗ 基线不绿（${CHECKER}），负向验证无法进行（FINV-8）`);
  console.error(baseline.out.trim().split('\n').slice(-6).join('\n'));
  process.exit(1);
}

let passed = 0;
const failures = [];

for (const c of CASES) {
  const original = readFileSync(c.file, 'utf8');
  const mutated = c.mutate(original);
  if (mutated === original) { failures.push(`${c.dim}: 注入未改变文件 —— 注入点已失效`); continue; }
  try {
    writeFileSync(c.file, mutated);
    const r = run();
    if (!r.red) failures.push(`${c.dim}: 注入后仍绿 —— 该维度没有真正在守`);
    else if (!r.out.includes(c.expect)) failures.push(`${c.dim}: 报红了但消息未命中 "${c.expect}"（§25.3）`);
    else { console.log(`  ✓ ${c.dim}：注入 → 红（消息命中）· 回滚 → 绿`); passed += 1; }
  } finally {
    writeFileSync(c.file, original);
  }
}

const after = run();
if (after.red) failures.push('回滚后基线仍红 —— 注入未被完整还原');

console.log('━'.repeat(60));
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`✗ 负向验证（projects）：${failures.length} 条未通过`);
  process.exit(1);
}
console.log(`✓ 负向验证（projects）：${passed}/${CASES.length} 条用例全部通过（VC-8 · PJ-1..PJ-7 七个维度）`);
