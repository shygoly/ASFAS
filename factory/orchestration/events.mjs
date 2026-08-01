// events.mjs — 工作流事件模型与 append-only 存储（ASFAS §41.5 · WF-1 / WF-6 / WF-7）
//
// ## 本文件的核心不变量：状态由事件推导，不另存权威当前状态
//   `WF-6`：事件 MUST append-only；状态由事件序列**推导**，MUST NOT 另存一份可被直接改写的
//   "当前状态"作为权威。理由与元语层要治的病完全同构——另存权威当前状态会立刻产生两个事实来源
//   （`FP-1`），且当二者分叉时无法判断哪个对。
//
//   缓存派生状态是允许的，但它 MUST 可从事件序列重建。本文件不做缓存。
//
// ## 属工厂层（Layer 2）
//   MUST NOT import 任何厂商 SDK——绑定由组合根注入（见 cli.mjs）。`RB-1` 机器守护这一点。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 事件类型闭集（§41.5）。新增类型 MUST 同时更新本表与消费方，否则事件会被静默丢弃。 */
export const EVENT_TYPES = Object.freeze({
  'workflow.started': '触发条件满足',
  'stage.entered': '阶段边界',
  'stage.exited': '阶段边界',
  'activity.completed': '活动产出 typed 结果',
  'gate.evaluated': '每个闸门逐个发出（WF-7：MUST NOT 合并）',
  'review.decided': 'Reviewer 出结论',
  'release.granted': '人工放行（阶段级，终态）',
  'path-release.requested': 'L2 活动产出改动集，请求对该改动集的人工放行（D-RELEASE-1）',
  'path-release.granted': '人放行具体改动集（IN-1：放行人 + 时间戳）',
  'workflow.terminated': '完成 / 放弃 / 升级',
});

/** 终止原因闭集。`WF-2` ⑥要求终止条件含放弃路径——只有"完成"的工作流会在第一次失败时变成人工救火。 */
export const TERMINAL_REASONS = Object.freeze(['completed', 'abandoned', 'escalated']);

const fail = (m) => { throw new TypeError(`WF 契约违反：${m}`); };

/**
 * 事件契约（`WF-6` 至少七个字段）。
 * @typedef {Object} WorkflowEvent
 * @property {string} event_id
 * @property {string} workflow_id
 * @property {number} seq          单调递增
 * @property {string} type         ∈ EVENT_TYPES
 * @property {string} emitted_at   ISO-8601 UTC
 * @property {object} payload      typed
 * @property {string|null} run_id  若由活动产生
 */
export function assertEvent(e) {
  if (!e || typeof e !== 'object') fail('事件须为对象');
  for (const f of ['event_id', 'workflow_id', 'type', 'emitted_at']) {
    if (typeof e[f] !== 'string' || !e[f]) fail(`事件缺字段 ${f}`);
  }
  if (!Number.isInteger(e.seq) || e.seq < 0) fail('事件 seq 须为非负整数（单调递增）');
  if (!(e.type in EVENT_TYPES)) fail(`事件类型 "${e.type}" 不在闭集（${Object.keys(EVENT_TYPES).join(' / ')}）`);
  if (!e.payload || typeof e.payload !== 'object') fail('事件 payload 须为对象（typed）');
  if (!('run_id' in e)) fail('事件缺 run_id 字段（无活动产生时须显式 null，不得省略）');
  return true;
}

/**
 * append-only 事件存储。一行一个 JSON 事件（JSONL）。
 *
 * 选 JSONL + 只用 appendFileSync 是因为**追加是文件系统层面的语义**：
 * 没有提供任何改写既有行的方法，比"约定不要改"强一个量级（`FINV-7` 同源）。
 * 已知限制（`FP-7`）：进程外仍可用编辑器改文件。真正的 append-only 强制点属存储层（`§50`），未接入。
 */
export class EventLog {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  /** 读全部事件。状态**只能**由这里推导。 */
  all() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  /**
   * 追加一个事件。seq 由已有事件数推导，调用方不得指定——
   * 让调用方定 seq 等于把单调性交给调用方保证，而这正是最容易写错的地方。
   */
  append(workflowId, type, payload, runId = null) {
    const seq = this.all().length;
    const e = {
      event_id: `evt-${seq}-${Date.now().toString(36)}`,
      workflow_id: workflowId,
      seq,
      type,
      emitted_at: new Date().toISOString(),
      payload,
      run_id: runId,
    };
    assertEvent(e);
    appendFileSync(this.path, `${JSON.stringify(e)}\n`);
    return e;
  }
}

/** 默认事件存储位置。与血缘目录同级但不是同一个东西（`§38.1`：checkpoint MUST NOT 用作血缘来源）。 */
export const defaultLogPath = (root, workflowId) => join(root, '.workflow-runs', `${workflowId}.jsonl`);
