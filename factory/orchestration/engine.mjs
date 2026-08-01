// engine.mjs — 工作流推进引擎（ASFAS §41 · FG-3 事件驱动 · AG-17 查表不发明）
//
// ## 引擎里没有模型
//   `FINV-9`：非确定性 MUST 被隔离在 Activity 内部。阶段之间的推进条件 MUST 是确定性的，
//   MUST NOT 由模型判断"是否可以进入下一步"。所以本文件只做四件事：
//   查表求下一阶段 · 逐个跑闸门 · 派活动给运行时 · 落事件。
//
// ## 运行时绑定由**注入**得到，不在本文件 import
//   `FINV-5` 的可测判据是"换绑定后 factory/ 零改动"。绑定的选择属组合根（cli.mjs）。
//   `RB-1` 机器守护 factory/ 零厂商 SDK 提及。

import { assertActivity, assertActivityResult, countsAsIteration } from '../runtime/interface.mjs';
import { deriveState, nextStage } from './workflow.mjs';
import { GUARDRAILS } from './guardrails.mjs';
import { recordFromActivity, writeRecord } from './lineage.mjs';
import { assertDispatchAllowed, levelForPath } from './projects.mjs';

/**
 * 推进工作流直到：终止、或停在需要人的地方。
 *
 * @param {object} opts
 * @param {import('./workflow.mjs').WorkflowDefinition} opts.wf
 * @param {import('./events.mjs').EventLog} opts.log
 * @param {{run: Function}} opts.adapter   RT-1 绑定，注入
 * @param {object} opts.input              触发输入
 * @param {(e:object)=>void} [opts.onEvent] 可观测性通道（RT-9：MUST NOT 用于推进）
 * @param {string} [opts.lineageRoot] 血缘目录的仓库根。`IN-13`：与工作流事件**分开存储**
 * @param {object} [opts.project] 被治理项目（`resolveProject()` 的返回）。给了就过两道门（`D-PROJ-1`）
 */
export async function advance({ wf, log, adapter, input, lineageRoot = null, project = null, onEvent = () => {} }) {
  const emit = (type, payload, runId = null) => {
    const e = log.append(wf.id, type, payload, runId);
    onEvent(e);
    return e;
  };

  let state = deriveState(log.all());
  if (state.status === 'pending') {
    emit('workflow.started', { workflow: wf.id, trigger: wf.trigger, input });
    state = deriveState(log.all());
  }
  if (state.status === 'terminated') return deriveState(log.all());

  // 从当前阶段的下一个开始；没有当前阶段就从头
  let stage = state.stage ? nextStage(wf, state.stage) : wf.stages[0];

  while (stage) {
    emit('stage.entered', { stage_id: stage.id, role: stage.role, action_level: stage.action_level });

    // ── 前置的确定性闸门（WF-3：确定性 → Reviewer → 人工放行，顺序已由定义校验保证）──
    const pre = stage.gates.filter((g) => g.class === 'structural' && g.id === 'intake-complete');
    let blocked = false;
    for (const g of pre) {
      const ok = Boolean(input && Object.values(input).every((v) => v !== undefined && v !== null && String(v).trim()));
      // WF-7：逐闸门发出，MUST NOT 合并为一个"全部闸门"事件——
      // 合并后无法回答"哪个闸门拦住了多少"，而这正是闸门拦截分布指标的数据来源。
      emit('gate.evaluated', { stage_id: stage.id, gate_id: g.id, gate_class: g.class, result: ok ? 'pass' : 'fail', criterion: g.criterion });
      if (!ok) { blocked = true; break; }
    }
    if (blocked) { if (await routeFailure({ wf, log, emit, stage, reason: '前置闸门未过' })) return deriveState(log.all()); stage = wf.stages.find((s) => s.id === wf.failure_routes[stage.id].to); continue; }

    // ── 人工放行闸门：停下等人，不是失败（§47：决策权不下放）──
    const release = stage.gates.find((g) => g.class === 'release');
    if (release) {
      emit('gate.evaluated', { stage_id: stage.id, gate_id: release.id, gate_class: 'release', result: 'pending', criterion: release.criterion });
      return deriveState(log.all());
    }

    // ── 确定性阶段：查表即可，不派活动（AG-17）──────────────
    if (stage.deterministic) {
      emit('stage.exited', { stage_id: stage.id, deterministic: true });
      stage = nextStage(wf, stage.id);
      continue;
    }

    // ── 派发前过两道门（D-PROJ-1）────────────────────────────
    // MUST 在派发**之前**：活动一旦跑起来再补检查，写已经发生了。
    if (project) {
      try {
        assertDispatchAllowed(project, stage.action_level);
      } catch (e) {
        emit('gate.evaluated', { stage_id: stage.id, gate_id: 'project-dispatch-gate', gate_class: 'permission', result: 'fail', criterion: 'FINV-3 等级门 + AG-14 归级门', detail: e.message });
        // §41.7：权限闸门失败 MUST **升级给人**，不回上一阶段——重试无意义。
        emit('workflow.terminated', { reason: wf.terminal.on_escalate, detail: e.message });
        return deriveState(log.all());
      }
      emit('gate.evaluated', { stage_id: stage.id, gate_id: 'project-dispatch-gate', gate_class: 'permission', result: 'pass', criterion: `项目 ${project.id}（${project.conformance}）允许 ${stage.action_level}` });
    }

    // ── 派活动给运行时 ──────────────────────────────────────
    const runId = `${wf.id}-${stage.id}-${Date.now().toString(36)}`;
    // tool_grants 由分级表按路径面推导（D-PROJ-1 已知代价③ / D-RELEASE-1 落地限定）：
    // L0 只读空集；写类活动授权 Write/Edit/Bash 等文件操作（RT-6 闭集）。
    // 未给 project 时（工厂自身工作流）保持空集——工厂侧编排不派写类活动。
    const grantsFromGrading = () => {
      if (!project?.grading || stage.action_level === 'L0') return [];
      const face = project.grading[stage.action_level];
      if (!face || face.paths.length === 0) return [];
      // 写类面 → 授权文件写与命令执行。工具名单是 SDKL 内置工具的子集（RT-13 纵深防御的另一侧）。
      return ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'BashOutput', 'KillShell'];
    };
    const activity = {
      run_id: runId,
      role: stage.role,
      action_level_ceiling: stage.action_level,
      semantic_refs: [],                       // FR-17：引用而非内容。研究工作流暂无切片索引，登记为空。
      tool_grants: grantsFromGrading(),        // RT-6 闭集；L0 只读空集，写类由分级表路径面推导
      // WF-8 ①③：输入与输出的 typed schema 都由工作流定义携带，运行时 MUST NOT 在执行期扩展。
      input: {
        task: input,
        contract: stage.prompt_contract ?? null,
        output_schema: stage.output_schema ?? null,
      },
      budget: { iterations: GUARDRAILS.max_iterations },
    };
    assertActivity(activity);

    const activityStartedAt = new Date().toISOString();
    const result = await adapter.run(activity);
    assertActivityResult(result);              // RT-5：绑定违约要在这里炸，不要让引擎拿到畸形结果去猜
    emit('activity.completed', { stage_id: stage.id, ok: result.ok, metering: result.metering, output: result.ok ? result.output : null, error: result.ok ? null : result.error }, runId);

    // ── Record 阶段（AG-2：MUST **无条件**执行）────────────────
    // 包括会话失败、超护栏中止、人工取消的情形。只记成功会话是有偏采样（CP-32）。
    // 放在 gate 之前是有意的：闸门判红也好、后面抛异常也好，这条记录已经落地了。
    if (lineageRoot) {
      writeRecord(lineageRoot, recordFromActivity({
        activity,
        result,
        startedAt: activityStartedAt,
        gates: [{ gate_id: 'activity-ok', result: result.ok ? 'pass' : 'fail' }],
        attempt: (deriveState(log.all()).retries[stage.id] ?? 0) + 1,
        goal: typeof input?.question === 'string' ? input.question : `执行 ${wf.id}/${stage.id}`,
      }));
    }

    if (!result.ok) {
      const counts = countsAsIteration(result.error.class);
      emit('gate.evaluated', { stage_id: stage.id, gate_id: 'activity-ok', gate_class: 'structural', result: 'fail', criterion: `活动成功返回（错误类 ${result.error.class}，${counts ? '计入' : '不计入'}迭代护栏）` });
      if (await routeFailure({ wf, log, emit, stage, reason: result.error.message, countsAsRetry: counts })) return deriveState(log.all());
      stage = wf.stages.find((s) => s.id === wf.failure_routes[stage.id].to);
      continue;
    }

    // ── L2 路径级放行（D-RELEASE-1：先干后放）────────────────
    // L2 活动在隔离副本已跑完（RT-10），改动集由运行时报告（changed_paths）。
    // 若改动集含 L2 面（含 AG-14 兜底的未匹配路径），停在 await_human 等人放行，
    // 不放行不合并生效。L1 及以下直接过（L1 是"自主 + 事后审计"）。
    if (project && stage.action_level === 'L2') {
      const changed = result.changed_paths ?? [];
      // 归级改动集中每个路径：任一路径归 L2 即触发放行请求；L3 命中直接升级（AG-15 短路）。
      const l3 = changed.find((p) => levelForPath(project.grading, p) === 'L3');
      if (l3) {
        emit('gate.evaluated', { stage_id: stage.id, gate_id: 'path-merge-gate', gate_class: 'permission', result: 'fail', criterion: '改动集归级', detail: `改动路径 \`${l3}\` 归 L3（AG-15 短路），L3 无放行路径` });
        emit('workflow.terminated', { reason: wf.terminal.on_escalate, detail: `L2 活动改动集含 L3 路径：${l3}` });
        return deriveState(log.all());
      }
      const hasL2 = changed.some((p) => levelForPath(project.grading, p) === 'L2');
      if (hasL2 || changed.length === 0) {
        // changed.length===0：活动声称成功但无改动集（diff 收集不可用或真的没改）→
        // 按 AG-14 fail-closed 视为未过放行，挂起等人工确认（不静默通过）。
        const payload = { run_id: runId, stage_id: stage.id, action_level: 'L2', changed_paths: changed, project: project.id };
        emit('path-release.requested', payload, runId);
        return deriveState(log.all());       // 停在 await_human（deriveState 识别 path-release.requested）
      }
    }

    // ── 后置的行为闸门（判据由工作流定义携带，此处按 gate id 分派）──
    let failedGate = null;
    for (const g of stage.gates.filter((x) => x.class === 'behavioral')) {
      const verdict = await evaluateBehavioral(wf, g, result.output);
      emit('gate.evaluated', { stage_id: stage.id, gate_id: g.id, gate_class: g.class, result: verdict.ok ? 'pass' : 'fail', criterion: g.criterion, detail: verdict.reason ?? null });
      if (!verdict.ok) { failedGate = g; break; }
    }
    if (failedGate) {
      if (await routeFailure({ wf, log, emit, stage, reason: `闸门 ${failedGate.id} 未过` })) return deriveState(log.all());
      stage = wf.stages.find((s) => s.id === wf.failure_routes[stage.id].to);
      continue;
    }

    emit('stage.exited', { stage_id: stage.id });
    stage = nextStage(wf, stage.id);
  }

  emit('workflow.terminated', { reason: wf.terminal.on_success });
  return deriveState(log.all());
}

/** 行为闸门的判据实现。按闸门 id 分派——判据本身属工作流定义，实现挂在这里。 */
async function evaluateBehavioral(wf, gate, output) {
  if (gate.id === 'wf26-evidence') {
    const { evaluateWF26 } = await import('./workflows/research.mjs');
    return evaluateWF26(output);
  }
  if (gate.id === 'tasks-complete') {
    const { evaluateTasks } = await import('./workflows/orchestrate.mjs');
    return evaluateTasks(output);
  }
  // FP-4 fail-closed：判据没有实现就不能算通过，否则闸门是摆设。
  return { ok: false, reason: `闸门 ${gate.id} 的判据未实现（fail-closed：未实现的闸门 MUST NOT 视为通过）` };
}

/**
 * `WF-11` 失败路由：达重试上限 MUST 升级给人，MUST NOT 静默重试或自动降低验收标准。
 * @returns {Promise<boolean>} true = 已终止（升级），调用方应停止推进
 */
async function routeFailure({ wf, log, emit, stage, reason, countsAsRetry = true }) {
  const route = wf.failure_routes[stage.id];
  if (!route) { emit('workflow.terminated', { reason: wf.terminal.on_escalate, detail: `阶段 ${stage.id} 无失败路由：${reason}` }); return true; }
  const used = deriveState(log.all()).retries[stage.id] ?? 0;
  // RT-7：transient / runtime_fault 不计入迭代护栏——基础设施抖动不是智能体的失败。
  if (countsAsRetry && used > route.max_retries) {
    emit('workflow.terminated', { reason: wf.terminal.on_escalate, detail: `阶段 ${stage.id} 达重试上限 ${route.max_retries}（AG-20：不换更强模型再试，反复失败是任务定义或知识缺口的信号）：${reason}` });
    return true;
  }
  return false;
}

/** 人工放行：把 release 闸门从 pending 推到 pass。`IN-1` 要求带身份与时间戳。 */
export function grantRelease(log, wf, { by, decision }) {
  const state = deriveState(log.all());
  if (state.status !== 'awaiting_human') throw new Error(`当前状态 ${state.status}，没有待放行的闸门`);
  log.append(wf.id, 'release.granted', { by, decision, granted_at: new Date().toISOString() });
  log.append(wf.id, 'workflow.terminated', { reason: wf.terminal.on_success, decision });
  return deriveState(log.all());
}

/**
 * **路径级人工放行**（`D-RELEASE-1`：先干后放）。
 * 与 `grantRelease`（阶段级、终态）不同：`path-release.granted` 是**非终态**——
 * 放行后工作流继续推进（`deriveState` 把它恢复为 running），改动集才合并生效。
 *
 * `IN-1`：放行须可归属到自然人（by + granted_at）。
 * 放行的是**具体改动集**（`IN-8` ③：绑定到改动集标识，不是开放白名单）。
 *
 * @param {EventLog} log
 * @param {string} wfId 工作流 id
 * @param {{by:string, run_id:string}} opts 放行人 + 被放行的活动 run_id
 */
export function grantPathRelease(log, wfId, { by, run_id }) {
  log.append(wfId, 'path-release.granted', { by, run_id, granted_at: new Date().toISOString() });
  return deriveState(log.all());
}

/**
 * 人工放弃。`WF-2` ⑥要求终止条件**含放弃路径**——
 * 没有放弃路径的流程会在第一次"候选都不行"时变成人工救火（有人手工删事件文件）。
 *
 * 不写血缘：血缘是**每次智能体会话**一份（`AG-7`），放弃不产生会话。
 * 已跑过的会话在当时就已落记录，放弃这个事实由事件序列承载。
 */
export function abandon(log, wf, { by, reason }) {
  const state = deriveState(log.all());
  if (state.status === 'terminated') throw new Error(`工作流已终止（${state.terminal_reason}），不能再放弃`);
  if (state.status === 'pending') throw new Error('工作流尚未启动，没有可放弃的实例');
  log.append(wf.id, 'workflow.terminated', { reason: wf.terminal.on_abandon, by, detail: reason, abandoned_at: new Date().toISOString() });
  return deriveState(log.all());
}
