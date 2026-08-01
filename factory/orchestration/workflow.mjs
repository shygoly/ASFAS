// workflow.mjs — 工作流定义契约与状态推导（ASFAS §41 · WF-2 / WF-3 / WF-10 / WF-11）
//
// §41.1 三层结构里的 **Workflow 层**：MUST 确定性、可重放。
// 本文件不含任何模型调用——推进条件若由模型判断，整条工作流就不可重放（`FINV-9`）。

import { TERMINAL_REASONS } from './events.mjs';

/** 闸门分类（§41.7）。`裁剪` 列是 MAY 被裁剪与否。 */
export const GATE_CLASSES = Object.freeze({
  structural: { executor: 'deterministic', trimmable: false },  // 元语校验器 · 类型检查 · 格式契约
  behavioral: { executor: 'deterministic', trimmable: false },  // 不变量测试 · 契约测试 · 回归
  permission: { executor: 'deterministic', trimmable: false },  // 动作等级归级 · 路径面匹配 · L3 拦截
  quality: { executor: 'reviewer', trimmable: true },           // 独立 diff 审查（裁剪 MUST 登记）
  release: { executor: 'human', trimmable: false },             // 人工放行（IN-1）
});

/** `WF-10` 不可裁剪子集：任何工作流（含热修复）MUST NOT 跳过这四类。 */
export const NON_TRIMMABLE = Object.freeze(['structural', 'behavioral', 'permission', 'release']);

/** `WF-3` 闸门顺序：确定性闸门 → Reviewer 闸门 → 人工放行。数字越小越靠前。 */
const GATE_ORDER = { structural: 0, behavioral: 0, permission: 0, quality: 1, release: 2 };

export const WORKFLOW_STATES = Object.freeze(['pending', 'running', 'awaiting_human', 'terminated']);

const fail = (m) => { throw new TypeError(`WF 契约违反：${m}`); };

/**
 * `WF-2`：每类工作流 MUST 定义六项。
 * **缺⑤失败路由与⑥终止条件的定义 MUST NOT 被接受**——没有失败路径的流程会在第一次失败时变成人工救火。
 *
 * @typedef {Object} WorkflowDefinition
 * @property {string} id
 * @property {string} trigger                         ① 触发条件
 * @property {Array<{id:string, role:string, action_level:string, gates:Array<{id:string, class:string, criterion:string}>}>} stages  ②③④
 * @property {Record<string,{to:string, max_retries:number}>} failure_routes  ⑤（WF-11：回退目标 + 重试上限）
 * @property {{on_success:string, on_abandon:string, on_escalate:string}} terminal  ⑥（含放弃路径）
 */
export function assertWorkflowDefinition(wf) {
  if (!wf || typeof wf !== 'object') fail('工作流定义须为对象');
  if (!wf.id) fail('工作流定义缺 id');
  if (!wf.trigger) fail(`${wf.id}: 缺 ① 触发条件`);

  if (!Array.isArray(wf.stages) || wf.stages.length === 0) fail(`${wf.id}: 缺 ② 阶段序列`);
  const stageIds = new Set();
  for (const s of wf.stages) {
    if (!s.id) fail(`${wf.id}: 存在无 id 的阶段`);
    if (stageIds.has(s.id)) fail(`${wf.id}: 阶段 id "${s.id}" 重复`);
    stageIds.add(s.id);
    if (!s.role) fail(`${wf.id}/${s.id}: 缺 ③ 角色`);
    if (!/^L[0-3]$/.test(s.action_level ?? '')) fail(`${wf.id}/${s.id}: ③ 动作等级 "${s.action_level}" 非法`);
    // L3 无放行路径，任何阶段都 MUST NOT 声明 L3 上限（§27.1 / AG-6）
    if (s.action_level === 'L3') fail(`${wf.id}/${s.id}: 阶段动作等级不得为 L3（L3 不设放行路径）`);

    if (!Array.isArray(s.gates)) fail(`${wf.id}/${s.id}: 缺 ④ 闸门位置`);
    let prev = -1;
    for (const g of s.gates) {
      if (!g.id) fail(`${wf.id}/${s.id}: 存在无 id 的闸门`);
      if (!(g.class in GATE_CLASSES)) fail(`${wf.id}/${s.id}/${g.id}: 闸门类别 "${g.class}" 不在 §41.7 分类学内`);
      // ④要求闸门位置**与判据**。没有判据的闸门无法判定通过与否，等于没有闸门。
      if (!g.criterion) fail(`${wf.id}/${s.id}/${g.id}: 缺闸门判据（④ 要求"闸门位置与判据"）`);
      const ord = GATE_ORDER[g.class];
      // WF-3：确定性闸门 MUST NOT 排在模型判断之后——让模型去审一个连类型检查都没过的改动是纯浪费，
      // 且会产生关于"它本来就不该存在的代码"的意见。
      if (ord < prev) fail(`${wf.id}/${s.id}: 闸门顺序违反 WF-3（${g.class} 排在了更后置的类别之后；须 确定性 → Reviewer → 人工放行）`);
      prev = ord;
    }
  }

  if (!wf.failure_routes || typeof wf.failure_routes !== 'object' || Object.keys(wf.failure_routes).length === 0) {
    fail(`${wf.id}: 缺 ⑤ 失败路由（WF-2：缺⑤的工作流定义 MUST NOT 被接受）`);
  }
  for (const [from, route] of Object.entries(wf.failure_routes)) {
    if (!stageIds.has(from)) fail(`${wf.id}: 失败路由的源阶段 "${from}" 不在阶段序列内`);
    if (!stageIds.has(route.to)) fail(`${wf.id}: 失败路由 ${from} → "${route.to}" 的目标阶段不存在`);
    // WF-11：每条失败路由 MUST 声明回退目标阶段与重试上限。达到上限 MUST 升级给人。
    if (!Number.isInteger(route.max_retries) || route.max_retries < 0) {
      fail(`${wf.id}: 失败路由 ${from} 缺重试上限（WF-11；无上限 = 静默重试）`);
    }
  }

  if (!wf.terminal) fail(`${wf.id}: 缺 ⑥ 终止条件（WF-2：缺⑥的工作流定义 MUST NOT 被接受）`);
  for (const k of ['on_success', 'on_abandon', 'on_escalate']) {
    if (!wf.terminal[k]) fail(`${wf.id}: ⑥ 终止条件缺 ${k}（含放弃路径是硬要求）`);
  }
  const bad = Object.values(wf.terminal).filter((v) => !TERMINAL_REASONS.includes(v));
  if (bad.length) fail(`${wf.id}: ⑥ 终止原因 "${bad.join(', ')}" 不在闭集（${TERMINAL_REASONS.join(' / ')}）`);

  // WF-10：四类不可裁剪闸门中，凡该工作流声明了的，MUST NOT 标记为可裁剪。
  for (const s of wf.stages) {
    for (const g of s.gates) {
      if (NON_TRIMMABLE.includes(g.class) && g.trimmed) {
        fail(`${wf.id}/${s.id}/${g.id}: ${g.class} 属不可裁剪子集，MUST NOT 被裁剪（WF-10）`);
      }
    }
  }
  return true;
}

/**
 * 从事件序列**推导**工作流状态。`WF-6`：MUST NOT 另存权威当前状态。
 *
 * 这个函数是 FLOWS.md 里 `workflow_run.status` 那台状态机的**唯一写入点**——
 * 校验器的 `impl` 双向对拍就指向这里。改状态语义必须先改 FLOWS.md。
 *
 * @returns {{status:string, stage:string|null, retries:Record<string,number>, terminal_reason:string|null}}
 */
export function deriveState(events) {
  let status = 'pending';
  let stage = null;
  let terminalReason = null;
  const retries = {};

  for (const e of events) {
    switch (e.type) {
      case 'workflow.started':
        status = 'running';
        break;
      case 'stage.entered':
        stage = e.payload.stage_id ?? stage;
        status = 'running';
        break;
      case 'gate.evaluated':
        // 人工放行闸门未过 = 等人，不是失败。区分这两者是 §47「决策权不下放」的落点。
        if (e.payload.gate_class === 'release' && e.payload.result === 'pending') status = 'awaiting_human';
        else if (e.payload.result === 'fail') retries[stage ?? '?'] = (retries[stage ?? '?'] ?? 0) + 1;
        break;
      case 'release.granted':
        status = 'running';
        break;
      // D-RELEASE-1：路径级放行挂起/放行（非终态）。放行后工作流继续推进。
      case 'path-release.requested':
        status = 'awaiting_human';
        break;
      case 'path-release.granted':
        status = 'running';
        break;
      case 'workflow.terminated':
        status = 'terminated';
        terminalReason = e.payload.reason ?? null;
        break;
      default:
        break;   // activity.completed / stage.exited / review.decided 不改变 status
    }
  }
  return { status, stage, retries, terminal_reason: terminalReason };
}

/** 查表求下一阶段。`AG-17`：Supervisor 查表，不发明——所以这里是纯函数，不接受任何模型输入。 */
export function nextStage(wf, currentStageId) {
  const i = wf.stages.findIndex((s) => s.id === currentStageId);
  if (i < 0) return wf.stages[0];
  return wf.stages[i + 1] ?? null;
}
