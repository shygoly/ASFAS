// projects.mjs — 编排面的项目维度（决策 `D-PROJ-1` · ASFAS IN-14 / FINV-3 / AG-14 / FINV-4）
//
// ## FINV-4 的落点：本文件只读 registry 字段与路径，不碰任何项目的元语内容
//   项目差异**只能**经 registry 字段与项目侧文件表达。本文件里 MUST NOT 出现任何具体项目的
//   id、术语或路径常量——出现即意味着工厂层依赖了某个项目的内容。
//
// ## 两道门都是 fail-closed（`FP-4`）
//   安全由**机制**保证，不由纪律保证。缺省值一律取最严：
//   `conformance` 缺失视为 `C0`（而不是"大概是 C1 吧"）；`action_levels` 缺失则全路径归 `L2`。
//   反过来（缺省宽松）的后果是：新接入一个还没配置好的项目，第一次派工就拿到了写权限。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseActionLevels } from './grading.mjs';

const LEVELS = Object.freeze(['C0', 'C1', 'C2', 'C3', 'C4']);
const ACTION_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);

/** 编排面（C3 能力）要求项目先达到的等级。`FINV-3`：等级 MUST NOT 跳跃。 */
export const MIN_CONFORMANCE_FOR_DISPATCH = 'C2';

/** 血缘目录的缺省值。非 C2 项目 registry 无 `lineage_dir` 字段时用它。 */
export const DEFAULT_LINEAGE_DIR = '.agent-runs';

const order = (c) => LEVELS.indexOf(c);
/** 写类活动 = 会改动工作副本的活动。`L0` 只读，不算。 */
export const isWriteLevel = (l) => ACTION_LEVELS.indexOf(l) >= ACTION_LEVELS.indexOf('L1');

const denied = (msg, cls = 'permission_denied') => {
  const e = new Error(msg);
  e.class = cls;                      // §35.3：立即升级，重试无意义
  return e;
};

/**
 * registry 的 `lineage_dir` / `action_levels` 都是**描述性字符串**（§13.2 只规定字段存在，
 * 不规定格式），参考实现里写成 `".agent-runs/（append-only，FINV-7；…）"` 这样带说明的形态。
 * 所以取值时只认前缀的路径 token，剩下的当注释。
 * 解析不出路径 token 时返回 null，由调用方 fail-closed 处理——**不猜**。
 *
 * 这里的宽松只作用于**定位**（哪个文件），不作用于**语义**（表格怎么读）。
 * 后者由 `D-GRADE-1` 严格 Schema 管——两者严格程度不同是有意的：
 * 定位猜错会立刻表现为"文件不存在/小节找不到"，语义猜错则静默错判权限。
 */
function leadingPathToken(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^([\w./-]+)/);
  const p = m?.[1]?.replace(/\/$/, '');
  return p && p !== '.' ? p : null;
}

export const parseLineageDir = leadingPathToken;

/**
 * 读并解析项目侧分级表（`D-GRADE-1`）。
 * 任一环节失败都返回 `{levels:null, error}`，`error` 指向具体环节——归级门原样转述给人。
 */
function readGrading(localPath, rawRef) {
  const rel = leadingPathToken(rawRef);
  if (!rel) return { levels: null, error: 'registry 无 action_levels 字段，或其中解析不出文件路径 token' };
  if (!localPath) return { levels: null, error: `action_levels 指向 ${rel}，但项目无 local_path，本机读不到分级表` };
  const file = join(localPath, rel);
  if (!existsSync(file)) return { levels: null, error: `分级表文件不存在：${rel}` };
  const r = parseActionLevels(readFileSync(file, 'utf8'));
  return r.levels ? r : { levels: null, error: `${rel} ${r.error}` };
}

/**
 * 解析一个被治理项目。
 *
 * 分级表在这里**一次性读盘并解析**，结果挂在返回值上。理由：归级门因此保持纯函数，
 * 用合成输入就能把象限走全（`check-projects.mjs` PJ-2 依赖这一点）；
 * 若门自己去读盘，那条断言就得在磁盘上摆出几个项目才能跑。
 *
 * @returns {{id, localPath:string|null, conformance:string, lineageDir:string|null,
 *            grading:object|null, gradingError:string|null}}
 */
export function resolveProject(factoryRoot, id) {
  const path = join(factoryRoot, 'projects', 'registry.json');
  if (!existsSync(path)) throw denied('projects/registry.json 不存在', 'capability_missing');
  const entry = JSON.parse(readFileSync(path, 'utf8')).find((e) => e.id === id);
  if (!entry) throw denied(`registry 中无项目 "${id}"（未登记的项目不得被派工，FP-4）`);

  // 缺省 C0 而不是报错：registry 可能是手写的，缺字段时按最严处理并让门去拦，
  // 报错会让"缺字段"和"真的是 C0"两种情况走不同路径，而它们的处置应当一样。
  const conformance = LEVELS.includes(entry.conformance) ? entry.conformance : 'C0';
  const localPath = entry.local_path ? resolve(factoryRoot, entry.local_path) : null;
  const grading = readGrading(localPath, entry.action_levels);

  return {
    id: entry.id,
    localPath,
    conformance,
    lineageDir: leadingPathToken(entry.lineage_dir),
    grading: grading.levels,
    gradingError: grading.error,
  };
}

/**
 * **等级门**（`FINV-3` / `D-PROJ-1`）。编排面是 C3 能力，
 * 「在 C1 未达成时启用 C3 编排面，等于给一群智能体发放无护栏的写权限」。
 */
export function assertConformanceGate(project, actionLevel) {
  if (!isWriteLevel(actionLevel)) return true;          // L0 只读，不过门
  if (order(project.conformance) < order(MIN_CONFORMANCE_FOR_DISPATCH)) {
    throw denied(
      `项目 ${project.id} 当前 ${project.conformance}，未达 ${MIN_CONFORMANCE_FOR_DISPATCH}，`
      + `禁止派发 ${actionLevel} 写类活动（FINV-3 等级门：等级不跳跃）`,
    );
  }
  return true;
}

/**
 * **归级门**（`AG-14` / `§27.6` / 决策 `D-GRADE-1` / `D-RELEASE-1`）。
 * 动作等级 MUST 可由机器判定，判定输入是**项目自己的**分级表。
 *
 * 三段判定，逐段 fail-closed：
 *   ① 分级表解析不了 → 全路径归 `L2`（`AG-14` 兜底）→ 拒。
 *      「新增目录若忘了登记，后果是"多要一次放行"而非"未经授权就改了合规代码"」。
 *   ② 表解析了但该等级路径面为空 → 没有可归级的东西，与"表不在"等效 → 拒。
 *   ③ `L2`（`D-RELEASE-1`：先干后放）→ 派发**允许**（活动在隔离副本执行，`RT-10`，
 *      放行前改动不落在项目工作区）；合并生效前须过 `assertMergeAllowed` 的路径级放行。
 *
 * 纯函数：只读 `project` 上已解析好的字段，不碰磁盘。
 */
export function assertGradingGate(project, actionLevel) {
  if (!isWriteLevel(actionLevel)) return true;

  if (!project.grading) {
    throw denied(
      `项目 ${project.id} 的归级表不可用 → 全路径 fail-closed 归 L2（AG-14），拒绝派发 ${actionLevel} 写类活动。`
      + `原因：${project.gradingError ?? '未知'}`,
    );
  }

  const face = project.grading[actionLevel];
  if (!face || face.paths.length === 0) {
    throw denied(`项目 ${project.id} 的分级表未给 ${actionLevel} 声明任何路径面，无法归级（D-GRADE-1 ⑤）`);
  }

  return true;
}

/**
 * **合并门**（`D-RELEASE-1`：先干后放）。L2 活动的实际改动集在合并生效前，
 * MUST 已获**路径级人工放行**（`IN-8` ③：放行绑定到具体改动集标识）。
 *
 * 判定：对改动集中每个路径，用分级表归级；任一路径归 `L2` → 要求该路径已放行。
 * 归级算法（`§27.6` / `AG-14` / `AG-15`）：未匹配任何路径面的路径归 `L2`（fail-closed）；
 * 匹配冲突取最具体，同具体度取更高等级；`L3` 命中短路（直接拒，L3 无放行路径）。
 *
 * @param {object} project  `resolveProject()` 的返回
 * @param {string[]} changedPaths  活动实际改写的路径（diff 来源，运行时报告）
 * @param {Set<string>} releasedPaths  已获人工放行的路径集（path-release.granted 累计）
 * @returns {true} 全部路径已放行
 * @throws {Error} 含未放行的 L2/L3 面
 */
export function assertMergeAllowed(project, changedPaths, releasedPaths) {
  if (!project.grading) {
    throw denied(
      `项目 ${project.id} 的归级表不可用 → 无法归级改动集（AG-14），拒绝合并。`
      + `原因：${project.gradingError ?? '未知'}`,
    );
  }
  const unReleased = [];
  for (const p of changedPaths ?? []) {
    const level = levelForPath(project.grading, p);
    if (level === 'L3') {
      throw denied(`项目 ${project.id}：改动路径 \`${p}\` 归 L3（AG-15 短路），L3 无放行路径（AG-6），拒绝合并`);
    }
    if (level === 'L2' && !releasedPaths.has(p)) {
      unReleased.push(p);
    }
  }
  if (unReleased.length) {
    throw denied(
      `项目 ${project.id}：改动集含 ${unReleased.length} 个未放行的 L2 路径（D-RELEASE-1：先干后放，`
      + '须路径级人工放行后才合并生效）：' + unReleased.slice(0, 5).join(', ') + (unReleased.length > 5 ? ' …' : ''),
    );
  }
  return true;
}

/**
 * 用项目分级表对单个路径归级（`§27.6` / `AG-14` / `AG-15`）。
 * @returns {'L0'|'L1'|'L2'|'L3'} 未匹配任何路径面 → 'L2'（AG-14 fail-closed）
 */
export function levelForPath(grading, path) {
  const matches = [];
  for (const lvl of ['L0', 'L1', 'L2', 'L3']) {
    const face = grading[lvl];
    if (!face) continue;
    for (const g of face.paths) {
      if (globToRe(g).test(path)) matches.push({ lvl, g });
    }
  }
  if (matches.length === 0) return 'L2';               // AG-14：未匹配 → L2
  if (matches.some((m) => m.lvl === 'L3')) return 'L3'; // AG-15：L3 短路
  // AG-15：取最具体匹配（字面段最多者优先）；同具体度取更高等级
  const specific = matches.sort((a, b) => b.g.length - a.g.length);
  const top = specific.filter((m) => m.g.length === specific[0].g.length);
  const levels = ['L0', 'L1', 'L2', 'L3'];
  return top.reduce((acc, m) => (levels.indexOf(m.lvl) > levels.indexOf(acc) ? m.lvl : acc), top[0].lvl);
}

/** glob → RegExp。与 spec/check-agent-ops.mjs 的 globToRe 同一形态（FP-1：工厂读项目的表和查自己的表判据须一致）。 */
function globToRe(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

/** 两道门一起过。派发前调用，MUST NOT 在活动执行期再补检查（那时已经晚了）。 */
export function assertDispatchAllowed(project, actionLevel) {
  assertConformanceGate(project, actionLevel);
  assertGradingGate(project, actionLevel);
  return true;
}

/**
 * 血缘落点。`§50.2`：血缘 MUST 与代码**同版本可追溯**，所以非在项目仓不可。
 * C2 走 registry 的 `lineage_dir`；非 C2 或解析不出时用缺省目录名——但仍在**项目侧**。
 */
export function lineageRootFor(project) {
  if (!project.localPath) {
    throw denied(`项目 ${project.id} 无 local_path，血缘无处可落（§50.2 要求与代码同版本可追溯）`, 'capability_missing');
  }
  if (!existsSync(project.localPath) || !statSync(project.localPath).isDirectory()) {
    throw denied(`项目 ${project.id} 的 local_path 在本机不存在：${project.localPath}`, 'capability_missing');
  }
  return join(project.localPath, project.lineageDir ?? DEFAULT_LINEAGE_DIR);
}

/**
 * 事件流落点。**工厂侧**按 project_id 分目录——这是 `D-PROJ-1` 的落地限定。
 *
 * `§50.2` 对工作流事件只要求"有序·持久·可按序重放"，**没有**同版本可追溯的要求，
 * 所以它不必进项目仓。每项目一个目录、互不可见，不构成 `IN-14` 禁止的跨项目写路径；
 * 同时规避了往项目树里写运行态可能干扰项目自身 `verify_cmd` 与元语扫描的代价。
 */
export function eventRootFor(factoryRoot, projectId = null) {
  return projectId ? join(factoryRoot, '.workflow-runs', projectId) : join(factoryRoot, '.workflow-runs');
}
