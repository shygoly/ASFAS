#!/usr/bin/env node
// cli.mjs — 编排面入口（组合根）
//
// ## 入口的形态不是"跟 supervisor 聊天"，是**触发一个工作流实例**
//   `WF-1`：工作流的每次推进 MUST 由显式事件触发并持久化。你在这里看到的是事件流，
//   不是对话流。人只在人工放行闸（`release`）与升级点介入。
//
// ## 绑定由配置决定，不硬编码
//   `FINV-5` 的可测判据是"换运行时后 factory/ 零改动"。所以绑定路径来自
//   `AI_FACTORY_RUNTIME_BINDING`，换厂商 = 改环境变量，不动 factory/。
//
// 用法：
//   node factory/orchestration/cli.mjs start research --question "…" --criterion "…"
//   node factory/orchestration/cli.mjs status <workflow_id>
//   node factory/orchestration/cli.mjs release <workflow_id> --by <人名> --decision "…"

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventLog } from './events.mjs';
import { lineageDir } from './lineage.mjs';
import { resolveProject, lineageRootFor, eventRootFor } from './projects.mjs';
import { assertWorkflowDefinition, deriveState } from './workflow.mjs';
import { advance, grantRelease, grantPathRelease, abandon } from './engine.mjs';
import { researchWorkflow } from './workflows/research.mjs';
import { orchestrateWorkflow } from './workflows/orchestrate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = { research: researchWorkflow, orchestrate: orchestrateWorkflow };
const DEFAULT_BINDING = 'runtime/claude-agent-sdk/adapter.mjs';

/** 事件流落点：**工厂侧**，按 project_id 分目录（`D-PROJ-1` 落地限定）。 */
const logPath = (workflowId, projectId = null) => join(eventRootFor(ROOT, projectId), `${workflowId}.jsonl`);

const projectDirs = () => (existsSync(eventRootFor(ROOT))
  ? readdirSync(eventRootFor(ROOT), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : []);

/**
 * 从已有实例反查它属于哪个项目——`status`/`release`/`abandon` 因此不必再传 `--project`。
 * 让人在放行时重复输入项目名，是给一个本可由事件推导的事实开第二个来源（`FP-1`）。
 */
function findLog(workflowId) {
  for (const pid of [null, ...projectDirs()]) {
    const p = logPath(workflowId, pid);
    if (existsSync(p)) return { log: new EventLog(p), projectId: pid };
  }
  return { log: new EventLog(logPath(workflowId)), projectId: null };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i += 1; }
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

/** 事件流的人类可读渲染。`RT-9`：可观测性通道，MUST NOT 用于推进。 */
const ICON = {
  'workflow.started': '▶', 'stage.entered': '┌', 'stage.exited': '└',
  'activity.completed': '·', 'gate.evaluated': '◆', 'review.decided': '◇',
  'release.granted': '✋', 'workflow.terminated': '■',
};
function render(e) {
  const p = e.payload;
  let line = `${ICON[e.type] ?? ' '} ${e.type}`;
  if (e.type === 'stage.entered') line += `  ${p.stage_id}（${p.role} · ${p.action_level}）`;
  if (e.type === 'stage.exited') line += `  ${p.stage_id}`;
  if (e.type === 'gate.evaluated') {
    const mark = { pass: '✓', fail: '✗', pending: '⏸' }[p.result] ?? '?';
    line += `  ${mark} ${p.gate_id}〔${p.gate_class}〕`;
    if (p.detail) line += `\n     ${p.detail}`;
  }
  if (e.type === 'activity.completed') {
    line += `  ${p.ok ? 'ok' : `失败：${p.error?.class}`}`;
    if (p.metering?.tokens_in != null) line += `  ${p.metering.tokens_in}→${p.metering.tokens_out} tok`;
    if (!p.ok && p.error?.message) line += `\n     ${p.error.message.slice(0, 160)}`;
  }
  if (e.type === 'workflow.terminated') line += `  ${p.reason}${p.detail ? `\n     ${p.detail}` : ''}`;
  console.log(`  ${String(e.seq).padStart(2)} ${line}`);
}

async function loadAdapter() {
  const rel = process.env.AI_FACTORY_RUNTIME_BINDING ?? DEFAULT_BINDING;
  const mod = await import(pathToFileURL(join(ROOT, rel)).href);
  return mod.default;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [cmd, arg] = positional;

if (cmd === 'start') {
  const wf = WORKFLOWS[arg];
  if (!wf) { console.error(`✗ 未知工作流 "${arg}"，可用：${Object.keys(WORKFLOWS).join(', ')}`); process.exit(2); }
  assertWorkflowDefinition(wf);                       // WF-2：六项不齐的定义 MUST NOT 被接受

  // --project：给了就把血缘落到**项目侧**、事件按 project_id 分目录，并在派发前过两道门（D-PROJ-1）
  let project = null;
  if (flags.project) {
    try { project = resolveProject(ROOT, flags.project); }
    catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  }
  const workflowId = `${wf.id}-${Date.now().toString(36)}`;
  const log = new EventLog(logPath(workflowId, project?.id ?? null));
  const tag = project ? `  project=${project.id}（${project.conformance}）` : '';
  console.log(`\n▶ ${wf.id}  workflow_id=${workflowId}${tag}\n`);

  const state = await advance({
    wf, log, adapter: await loadAdapter(), onEvent: render,
    lineageRoot: project ? lineageRootFor(project) : lineageDir(ROOT),   // §50.2：血缘 MUST 与代码同版本可追溯 → 项目侧
    project,
    input: { question: flags.question, criterion: flags.criterion },
  });

  console.log(`\n  状态：${state.status}${state.terminal_reason ? `（${state.terminal_reason}）` : ''}`);
  if (state.status === 'awaiting_human') {
    console.log(`  人是唯一的拍板者（§47）。放行：\n    node factory/orchestration/cli.mjs release ${workflowId} --by <你的名字> --decision "<选定的候选>"`);
  }
  console.log(`  事件：${log.path}\n`);
  process.exit(state.status === 'terminated' && state.terminal_reason !== 'completed' ? 1 : 0);
} else if (cmd === 'status') {
  const { log } = findLog(arg);
  const events = log.all();
  if (events.length === 0) { console.error(`✗ 无此工作流实例：${arg}`); process.exit(1); }
  console.log(`\n▶ ${arg}\n`);
  events.forEach(render);
  const s = deriveState(events);
  console.log(`\n  状态：${s.status}  阶段：${s.stage ?? '-'}  重试：${JSON.stringify(s.retries)}\n`);
} else if (cmd === 'release') {
  const { log } = findLog(arg);
  const wfId = log.all()[0]?.workflow_id;
  const wf = WORKFLOWS[wfId];
  if (!wf) { console.error(`✗ 无此工作流实例或类型未知：${arg}`); process.exit(1); }
  if (!flags.by) { console.error('✗ --by 必填：放行须可归属到自然人（IN-1）'); process.exit(2); }
  const s = grantRelease(log, wf, { by: flags.by, decision: flags.decision ?? '' });
  console.log(`\n✋ 已放行  by=${flags.by}  状态：${s.status}（${s.terminal_reason}）\n`);
  } else if (cmd === 'path-release') {
    // D-RELEASE-1：路径级放行（非终态）。--run 指定被放行的活动 run_id。
    const { log } = findLog(arg);
    const wfId = log.all()[0]?.workflow_id;
    if (!wfId) { console.error(`✗ 无此工作流实例：${arg}`); process.exit(1); }
    if (!flags.by) { console.error('✗ --by 必填：放行须可归属到自然人（IN-1）'); process.exit(2); }
    if (!flags.run) { console.error('✗ --run 必填：须指定被放行的活动 run_id（IN-8 ③：放行绑定到具体改动集）'); process.exit(2); }
    const s = grantPathRelease(log, wfId, { by: flags.by, run_id: flags.run });
    console.log(`\n✋ 已路径级放行  by=${flags.by}  run=${flags.run}  状态：${s.status}（${s.terminal_reason ?? '-'}）\n`);
  } else if (cmd === 'abandon') {
    const { log } = findLog(arg);
    const wfId = log.all()[0]?.workflow_id;
    const wf = WORKFLOWS[wfId];
    if (!wf) { console.error(`✗ 无此工作流实例或类型未知：${arg}`); process.exit(1); }
    if (!flags.by) { console.error('✗ --by 必填：放弃同样须可归属到自然人（IN-1）'); process.exit(2); }
    const s = abandon(log, wf, { by: flags.by, reason: flags.reason ?? '' });
    console.log(`\n⊘ 已放弃  by=${flags.by}  状态：${s.status}（${s.terminal_reason}）\n`);
  } else {
  console.log(`用法：
  start <workflow> [--project <id>] --question "…" --criterion "…"
                                                    触发工作流实例
  status <workflow_id>                              重放事件流并推导状态
  release <workflow_id> --by <人名> --decision "…"  人工放行（阶段级，终态）
  path-release <workflow_id> --by <人名> --run <run_id>  路径级放行 L2 改动集（D-RELEASE-1，非终态）
  abandon <workflow_id> --by <人名> --reason "…"    人工放弃（WF-2 ⑥ 的放弃路径）

可用工作流：${Object.keys(WORKFLOWS).join(', ')}
运行时绑定：${process.env.AI_FACTORY_RUNTIME_BINDING ?? `${DEFAULT_BINDING}（默认，可用 AI_FACTORY_RUNTIME_BINDING 覆盖）`}`);
  process.exit(cmd ? 2 : 0);
}
