// scan.mjs — 扫描面（VC-6）
//
// ASFAS §22.2 的教训：检查器的**扫描面**和检查逻辑一样重要。面漏了，检查再严也照不到。
// 参考实现中一个环境变量因扫描面漏了一个目录而长期未被登记 —— 检查器一直在跑、一直是绿的。
//
// 因此本模块要求扫描面**显式声明**，并提供**反向枚举**：
// 全仓扫一遍，把命中但不在扫描面内的位置列为警告 ——
// 把"我不知道我不知道什么"变成"我知道有个地方我没查"。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// 忽略列表分两类，**这个区分不是洁癖**：
//   ALWAYS —— 名字无歧义，任何深度都是产物/元数据
//   ROOT_ONLY —— 名字有歧义：`build` / `dist` / `target` 既可能是构建产物目录，
//     也可能是**源码目录**（如 apps/api/src/build/ 这个业务模块）。
//     按 basename 无差别忽略会静默跳过源码 —— 本模块在真实项目上首次运行时
//     即因此漏掉一整个模块，进而误报"某 env 键缺于代码"。
//     这正是 §22.2 那类扫描面缺陷：检查器一直在跑，只是照不到。
const ALWAYS_IGNORE = ['node_modules', '.git', '.hg', 'coverage', '.next', '.turbo', '.venv', '__pycache__'];
const ROOT_ONLY_IGNORE = ['dist', 'build', 'out', 'target', 'vendor'];

/** 递归列出目录下的文件（相对 root 的 posix 风格路径） */
export function walk(root, { dirs = ['.'], exts = null, ignore = ALWAYS_IGNORE } = {}) {
  const out = [];
  const visit = (abs, depth) => {
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      const base = abs.split(sep).pop();
      if (ignore.includes(base)) return;
      if (depth === 1 && ROOT_ONLY_IGNORE.includes(base)) return;   // 仅仓库根一层
      for (const e of readdirSync(abs)) visit(join(abs, e), depth + 1);
      return;
    }
    if (exts && !exts.some((x) => abs.endsWith(x))) return;
    out.push(relative(root, abs).split(sep).join('/'));
  };
  for (const d of dirs) visit(join(root, d), d === '.' ? 0 : 1);
  return out.sort();
}

export function readText(root, rel) {
  try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; }
}

/**
 * 在声明的扫描面内提取匹配项。
 * surface 必须是显式数组（VC-6）—— 不接受"全仓"这种隐式面。
 */
export function scanSurface(root, surface, pattern, { exts = null } = {}) {
  const files = walk(root, { dirs: surface, exts });
  const hits = [];
  for (const f of files) {
    const t = readText(root, f);
    if (t == null) continue;
    for (const m of t.matchAll(pattern))
      hits.push({ file: f, value: m[1] ?? m[0], groups: m.slice(1), index: m.index });
  }
  return hits;
}

/**
 * 反向枚举：全仓扫描，返回命中但**不在**声明扫描面内的文件。
 * 输出是**警告**而非失败 —— 可能确有合法例外，但例外必须浮出水面。
 */
export function reverseEnumerate(root, surface, pattern, { exts = null } = {}) {
  const inSurface = new Set(walk(root, { dirs: surface, exts }));
  const all = walk(root, { dirs: ['.'], exts });
  const strays = [];
  for (const f of all) {
    if (inSurface.has(f)) continue;
    const t = readText(root, f);
    if (t == null) continue;
    const m = [...t.matchAll(pattern)];
    if (m.length) strays.push({ file: f, count: m.length, sample: m[0][1] ?? m[0][0] });
  }
  return strays;
}

/** 路径面 glob 是否能匹配到真实存在的路径（MS-38，防表格腐烂） */
export function globResolves(root, glob) {
  const base = glob.replace(/\*\*.*$/, '').replace(/\*.*$/, '').replace(/\/+$/, '');
  if (!base) return true;                       // 形如 **/x 的全局面，不校验
  try { statSync(join(root, base)); return true; } catch { return false; }
}
