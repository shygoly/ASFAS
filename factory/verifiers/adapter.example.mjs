// adapter.example.mjs — 项目适配器接口（复制到项目，改名为 governance.adapter.mjs）
//
// **这是工厂与项目之间的唯一接口。** 工厂的校验器不知道你的技术栈 ——
// 它只知道"元语的 schema"（FINV-4）。代码侧的事实由本文件提供。
//
// 每个函数返回**代码侧的闭集**，由校验器与元语文档做对拍。
// 返回 null 表示"本项目不适用该维度"，对应检查将被跳过并计入警告 ——
// **跳过必须可见**，静默跳过是假绿（PS-3）。

// 适配器**不 import 工厂内部模块** —— 它属于项目，只用标准库，
// 避免项目与工厂之间产生除接口以外的耦合（FR-14 接口收窄）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const IGNORE = ['node_modules', '.git', 'dist', 'build', 'coverage'];
const readText = (root, rel) => { try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; } };
const walk = (root, dirs, exts) => {
  const out = [];
  const visit = (abs) => {
    let st; try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      if (IGNORE.includes(abs.split(sep).pop())) return;
      for (const e of readdirSync(abs)) visit(join(abs, e));
    } else if (!exts || exts.some((x) => abs.endsWith(x))) {
      out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  for (const d of dirs) visit(join(root, d));
  return out;
};

/** @type {import('./types').Adapter} */
export default {
  /** 项目根目录（绝对路径） */
  root: process.cwd(),

  /** 元语文件位置。缺失的条件元语填 null（MS-2：不触发则不得创建）。 */
  metaFiles: {
    ARCHITECTURE: 'ARCHITECTURE.md',
    DESIGN: 'DESIGN.md',
    DOMAIN: 'DOMAIN.md',
    FLOWS: 'FLOWS.md',
    DECISIONS: 'DECISIONS.md',
    DEPLOY: 'DEPLOY.md',
    AGENTS: 'AGENTS.md',
    AI: null,
    'AGENT-OPS': null,
  },

  /** DECISIONS.md 使用的 ID 前缀（附录 B.3）。词边界匹配，故前缀不得互为前缀。 */
  idPrefixes: ['INV', 'ADR', 'B', 'DS', 'D', 'AO', 'F'],

  /** 扫描 ID 引用的面。**显式声明**（VC-6）；反向枚举会报告面外命中。 */
  idScanSurface: ['src', 'apps', 'packages', 'scripts'],
  idScanExts: ['.ts', '.tsx', '.js', '.mjs', '.sql', '.py', '.go', '.rs'],

  // ── DOMAIN 对拍 ────────────────────────────────────────────
  /** @returns {string[]|null} 代码侧数据对象名闭集 */
  schemaObjects() {
    // 示例：从 schema 定义中提取。请按本项目实际写法实现。
    const t = readText(this.root, 'packages/db/src/schema.ts');
    if (t == null) return null;
    return [...t.matchAll(/pgTable\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  },

  /** @returns {Record<string,string[]>|null} 枚举名 → **有序**取值（MS-20 顺序敏感） */
  schemaEnums() {
    const t = readText(this.root, 'packages/db/src/schema.ts');
    if (t == null) return null;
    const out = {};
    for (const m of t.matchAll(/pgEnum\(\s*['"]([^'"]+)['"]\s*,\s*\[([^\]]*)\]/g)) {
      out[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    return out;
  },

  // ── FLOWS 对拍 ─────────────────────────────────────────────
  /**
   * 某个状态在代码中是否存在写入点。
   * @param {string} machine 形如 "对象.状态字段"
   * @param {string} state   目标状态取值
   * @returns {boolean|null} null = 无法判定（将计入警告，不判红）
   */
  stateHasWriter(machine, state) {
    // ⚠ **本默认实现一律返回 null（= 无法判定 → 走警告，不判红）。**
    //
    // 曾经在这里放过一个"窗口法"启发式（在提及该表的 update/insert 附近找状态字面量）。
    // 在真实项目上首次运行时它两个方向都出错：
    //   · 21 条 impl:yes 被误报为"找不到写入点"（ORM 用链式/构建器写法，窗口匹配不到）
    //   · 2 条 impl:no 被误报为"存在写入点"（400 字符窗口跨越了无关代码）
    // 假阳性比没有检查更坏：它教人"红是常态"（FINV-8），随后整个闸门被忽略。
    //
    // **判定某个状态有无写入点，需要该项目的实际写法知识 —— 这正是适配器存在的理由。**
    // 请按本项目的 ORM / SQL 写法实现，实现后本检查才真正生效（FL-5）。
    void machine; void state;
    return null;
  },

  /** @returns {boolean|null} `via` 声明的入口是否可解析（路由 / 调度器符号） */
  viaResolves(via) {
    if (via === '-' || !via) return null;
    const files = walk(this.root, ["apps", "src"], [".ts", ".js"]);
    const sched = via.match(/^scheduler:(.+)$/);
    const needle = sched ? sched[1] : via.replace(/^[A-Z]+\s+/, '').split('/').filter(Boolean).pop();
    if (!needle) return null;
    return files.some((f) => (readText(this.root, f) ?? '').includes(needle));
  },

  // ── DEPLOY 三方对拍 ────────────────────────────────────────
  envSampleFile: '.env.example',
  /**
   * 代码读取环境变量的扫描面。**必须覆盖前端构建配置**（§22.2 的盲区来源：
   * 某个 env 键因扫描面漏了前端目录而长期未登记，检查器一直是绿的）。
   *
   * 但**须排除治理脚本自身** —— 它们在正则与文档字符串里提到 `process.env.X`
   * 这类通配写法，会被当成真实键读入，产生假键（真实项目上首次运行即命中）。
   */
  envScanSurface: ['apps', 'packages', 'src', 'vite.config.ts'],
  envScanExts: ['.ts', '.tsx', '.js', '.mjs'],
  /** 提取代码中读取的 env 键 */
  envReads() {
    const keys = new Set();
    for (const f of walk(this.root, this.envScanSurface, this.envScanExts)) {
      const t = readText(this.root, f) ?? "";
      for (const m of t.matchAll(/process\.env\.([A-Z0-9_]+)|import\.meta\.env\.([A-Z0-9_]+)/g))
        keys.add(m[1] ?? m[2]);
    }
    return [...keys];
  },

  // ── ARCHITECTURE / DESIGN ──────────────────────────────────
  /** 反模式/边界的守护方式是否可定位（脚本存在 / CI job 存在） */
  guardResolves(spec) {
    if (/评审把关|待配|未配|仅文档约束/.test(spec)) return null;   // 显式无守护 → 警告而非红
    const path = spec.match(/`([^`]+\.(?:mjs|js|ts|sh|yml|yaml))`/);
    if (path) return readText(this.root, path[1]) != null;
    return null;
  },
};
