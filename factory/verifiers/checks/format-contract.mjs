// checks/format-contract.mjs — 格式契约先验（VC-3）
//
// 本检查**必须先于所有内容检查运行**。理由：如果有人把契约表格改写成散文，
// 内容检查会解析出 0 行，然后"没有发现任何违规" —— 一种典型的假绿（PS-3）。
// 解析空转必须视为失败而非通过。

import { readText } from '../lib/scan.mjs';
import { parseTables, fencedBlocks, hasFormatContract, leftoverPlaceholders, relativeLinks } from '../lib/md.mjs';
import { createReporter } from '../lib/report.mjs';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const CORE = ['ARCHITECTURE', 'DESIGN', 'DOMAIN', 'FLOWS', 'DECISIONS', 'DEPLOY'];

export default function checkFormatContract(a) {
  const r = createReporter('format-contract');
  const present = [];

  for (const [name, rel] of Object.entries(a.metaFiles)) {
    if (rel == null) continue;
    const t = readText(a.root, rel);
    if (t == null) { r.fail('FC-1', `${name}: 声明为 \`${rel}\` 但文件不存在`); continue; }
    present.push(name);

    // 抬头块（MS-6）
    if (!/^#\s.+\n\n>\s/m.test(t)) r.fail('FC-2', `${rel}: 缺抬头块（标题后须紧跟 SoT 声明引用块，MS-6）`);

    // 元语须有格式契约附录 + 兜底；AGENTS 是入口指针，不要求（FR-8）
    if (name !== 'AGENTS') {
      const fc = hasFormatContract(t);
      if (!fc.ok) r.fail('FC-3', `${rel}: ${fc.why}（MS-8）`);
    }

    // 解析目标非空 —— 每本元语至少须解析出一张表或一个 flow 块
    const tables = parseTables(t).filter((x) => x.rows.length);
    const flows = fencedBlocks(t, 'flow');
    if (name !== 'AGENTS' && tables.length === 0 && flows.length === 0)
      r.fail('FC-4', `${rel}: 未解析到任何契约表或 flow 块 —— 解析空转 = 红（MS-8）`);

    // 残留模板占位符（MS-46）
    const ph = leftoverPlaceholders(t);
    if (ph.length) r.fail('FC-5', `${rel}: 残留 ${ph.length} 处模板占位符 ${ph.slice(0, 5).join(' ')} —— 未完成的事实声明比缺失更危险（MS-46）`);

    // 相对路径链接可解析（MS-5）
    for (const link of relativeLinks(t)) {
      const abs = link.startsWith('/') ? join(a.root, link) : join(a.root, link.startsWith('.') ? '' : '', link);
      try { statSync(abs); } catch {
        try { statSync(join(a.root, rel, '..', link)); } catch {
          r.fail('FC-6', `${rel}: 链接目标不存在 → \`${link}\``);
        }
      }
    }
  }

  // 六本核心元语齐备（FR-6 / CP-1）
  const missing = CORE.filter((c) => !present.includes(c));
  if (missing.length) r.fail('FC-0', `核心元语缺失：${missing.join(', ')}（FR-6）`);
  if (!a.metaFiles.AGENTS) r.fail('FC-0', 'AGENTS.md 入口文件缺失（FR-6）');

  if (!r.failed) r.pass(`格式契约先验：${present.length} 份元语抬头块 / 格式契约 / 解析目标 / 链接 全部合规`);
  return r;
}
