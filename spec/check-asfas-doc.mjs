#!/usr/bin/env node
// check-asfas-doc.mjs — ASFAS 自校验器（FR-1）
//
// 契约：VC-1 确定性 · VC-2 只诊断无 --fix · VC-3 格式先验（解析空转 = 红）
//       VC-4 双向 · VC-5 面向工作区（直接读磁盘）· VC-6 扫描面显式
//
// 检查维度（每条须有负向验证，VC-8）：
//   A  章节 id 连续（ch1..ch55）且与侧栏导航双向一致
//   B  规范性陈述 rid 唯一，各命名空间编号连续
//   C  内部引用 href="#x" 全部可解析
//   D  附录 B 声明的数量 == 实际出现次数        ← 数字漂移守护（MA-1）
//   E  CP 编号连续且附录 A 与附录 B 计数一致
//   F  SVG 内不含非 SVG 元素                    ← <strong> 会中断 SVG 解析
//   G  块级标签平衡
//   H  每个 Part 的 part-head 存在
//   I  templates/ 与元语全集一致，且每份模板结构合规、仍是模板

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.argv.includes('--fix')) {
  console.error('✗ VC-2：治理只诊断、不自动改。本校验器不提供 --fix。');
  process.exit(2);
}

// ── 扫描面（VC-6：显式声明，便于审查完整性）─────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = join(HERE, 'ASFAS.html');
const TEMPLATE_DIR = join(HERE, '..', 'templates');
const CHAPTER_COUNT = 55;
// 元语全集（§15.2）：6 核心 + 2 条件 + AGENTS.md 入口指针（FR-6 要求 C0 齐备）
const CORE_META = ['ARCHITECTURE', 'DESIGN', 'DOMAIN', 'FLOWS', 'DECISIONS', 'DEPLOY'];
const COND_META = ['AI', 'AGENT-OPS'];
const ENTRY_DOC = ['AGENTS'];
const MIN_PLACEHOLDERS = 5;
const PARTS = ['partI', 'partII', 'partIII', 'partIV', 'partV', 'partVI', 'partVII', 'partVIII', 'appendix'];
const BLOCK_TAGS = ['div', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'aside', 'main', 'nav',
  'figure', 'figcaption', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'span', 'strong', 'kbd', 'svg', 'text'];
const SVG_ALLOWED = new Set(['svg', 'g', 'defs', 'marker', 'path', 'rect', 'line', 'circle', 'ellipse',
  'polyline', 'polygon', 'text', 'tspan', 'textPath', 'use', 'symbol', 'clipPath', 'mask',
  'linearGradient', 'radialGradient', 'stop', 'title', 'desc']);

const h = readFileSync(TARGET, 'utf8');
const problems = [];
const ok = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);

// ── VC-3 格式先验：解析目标不得空转 ──────────────────────────
const ridMatches = [...h.matchAll(/class="rid">\s*([A-Za-z]+-\d+)\s*</g)].map((m) => m[1]);
const chapterIds = [...h.matchAll(/\sid="ch(\d+)"/g)].map((m) => +m[1]);
// 逐行解析附录 B：先切出单个 <tr>（禁止跨行匹配 —— 跨 <tr> 会读到别行的数字），
// 再取该行最后一个 <td> 的前导数字。
const nsTableRows = [...h.matchAll(/<tr>((?:(?!<\/tr>)[\s\S])*?)<\/tr>/g)]
  .map(([, row]) => {
    const ns = row.match(/^<td><code>([A-Z]+)-n<\/code><\/td>/);
    if (!ns) return null;
    const cells = [...row.matchAll(/<td>((?:(?!<\/td>)[\s\S])*)<\/td>/g)].map((m) => m[1]);
    const last = cells[cells.length - 1] ?? '';
    const num = last.match(/^\s*(\d+)/);
    return num ? [row, ns[1], num[1]] : null;
  })
  .filter(Boolean);

if (ridMatches.length === 0) fail('VC-3 格式契约：未解析到任何规范性陈述（rid）—— 解析空转 = 红');
if (chapterIds.length === 0) fail('VC-3 格式契约：未解析到任何章节 id —— 解析空转 = 红');
if (nsTableRows.length === 0) fail('VC-3 格式契约：附录 B 命名空间表解析为 0 行 —— 解析空转 = 红');
if (problems.length) { report(); process.exit(1); }

// ── A 章节连续性 ──────────────────────────────────────────────
{
  const missing = [];
  for (let i = 1; i <= CHAPTER_COUNT; i++) if (!chapterIds.includes(i)) missing.push(i);
  const dupes = chapterIds.filter((v, i) => chapterIds.indexOf(v) !== i);
  if (missing.length) fail(`A 章节缺失：ch${missing.join(', ch')}`);
  if (dupes.length) fail(`A 章节 id 重复：ch${[...new Set(dupes)].join(', ch')}`);
  const navRefs = [...h.matchAll(/<a href="#ch(\d+)"><span class="n">/g)].map((m) => +m[1]);
  const navMissing = chapterIds.filter((c) => !navRefs.includes(c));
  const navOrphan = navRefs.filter((c) => !chapterIds.includes(c));
  if (navMissing.length) fail(`A 侧栏导航漏项：ch${navMissing.join(', ch')}`);
  if (navOrphan.length) fail(`A 侧栏导航指向不存在的章节：ch${navOrphan.join(', ch')}`);
  if (!missing.length && !dupes.length && !navMissing.length && !navOrphan.length)
    pass(`A 章节 ${chapterIds.length}/${CHAPTER_COUNT} 连续，与侧栏导航双向一致`);
}

// ── B rid 唯一 + 命名空间连续 ─────────────────────────────────
const nsActual = {};
{
  const dupes = ridMatches.filter((v, i) => ridMatches.indexOf(v) !== i);
  if (dupes.length) fail(`B 规范性陈述编号重复：${[...new Set(dupes)].join(', ')}`);
  for (const r of ridMatches) {
    const i = r.lastIndexOf('-');
    (nsActual[r.slice(0, i)] ||= []).push(+r.slice(i + 1));
  }
  const gaps = [];
  for (const [ns, nums] of Object.entries(nsActual)) {
    const s = [...nums].sort((a, b) => a - b);
    for (let i = s[0]; i <= s[s.length - 1]; i++) if (!s.includes(i)) gaps.push(`${ns}-${i}`);
  }
  if (gaps.length) fail(`B 命名空间编号不连续，缺：${gaps.join(', ')}`);
  if (!dupes.length && !gaps.length)
    pass(`B ${ridMatches.length} 条规范性陈述，${Object.keys(nsActual).length} 个命名空间编号连续无重号`);
}

// ── C 内部引用可解析 ──────────────────────────────────────────
{
  const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...h.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const broken = [...new Set(refs.filter((r) => !ids.has(r)))];
  if (broken.length) fail(`C 断链 ${broken.length} 处：#${broken.join(', #')}`);
  else pass(`C ${refs.length} 处内部引用全部可解析（${ids.size} 个锚点）`);
}

// ── D 附录 B 声明的数量 == 实际（MA-1 数字漂移守护）───────────
{
  const drift = [];
  for (const [, ns, declared] of nsTableRows) {
    const actual = (nsActual[ns] || []).length;
    if (actual === 0) continue; // 表格类命名空间（MA/PS）不以 rid 形式出现，另行校验
    if (actual !== +declared) drift.push(`${ns}: 附录 B 写 ${declared}，实际 ${actual}`);
  }
  if (drift.length) fail(`D 附录 B 数量漂移 —— ${drift.join(' · ')}`);
  else pass(`D 附录 B 声明的数量与实际出现次数一致（${nsTableRows.length} 个命名空间）`);
}

// ── E CP 编号连续 + 附录 A/B 计数一致 ─────────────────────────
{
  const cps = [...new Set([...h.matchAll(/<code>CP-(\d+)<\/code>/g)].map((m) => +m[1]))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i <= cps[cps.length - 1]; i++) if (!cps.includes(i)) gaps.push(i);
  if (gaps.length) fail(`E 一致性检查点编号不连续，缺：CP-${gaps.join(', CP-')}`);
  const declared = nsTableRows.find((r) => r[1] === 'CP');
  if (declared && +declared[2] !== cps.length)
    fail(`E CP 计数漂移：附录 B 写 ${declared[2]}，实际 ${cps.length}`);
  if (!gaps.length && (!declared || +declared[2] === cps.length))
    pass(`E 一致性检查点 CP-1..CP-${cps[cps.length - 1]} 连续，共 ${cps.length} 条`);
}

// ── F SVG 内不得含非 SVG 元素 ─────────────────────────────────
// HTML5 foreign-content 规则：<strong>/<b>/<p>/<span> 等会**中断 SVG 解析**，
// 其后内容掉出图外成为 HTML 兄弟节点。标签平衡检查看不到这个。
{
  const blocks = h.match(/<svg[\s\S]*?<\/svg>/g) || [];
  if (blocks.length === 0) fail('F 未解析到任何 SVG —— 解析空转');
  const bad = [];
  blocks.forEach((blk, i) => {
    const tags = [...new Set([...blk.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[\s>/]/g)].map((m) => m[1]))];
    const illegal = tags.filter((t) => !SVG_ALLOWED.has(t));
    if (illegal.length) {
      const label = (blk.match(/aria-label="([^"]*)"/) || [, `#${i + 1}`])[1];
      bad.push(`「${label}」含 <${illegal.join('>, <')}>`);
    }
  });
  if (bad.length) fail(`F SVG 内含非 SVG 元素（会中断解析，内容掉出图外）：${bad.join(' · ')}`);
  else pass(`F ${blocks.length} 张 SVG 内无非法元素`);
}

// ── G 块级标签平衡 ────────────────────────────────────────────
{
  const bad = [];
  for (const t of BLOCK_TAGS) {
    const open = (h.match(new RegExp(`<${t}(?=[\\s>])`, 'g')) || []).length;
    const close = (h.match(new RegExp(`</${t}>`, 'g')) || []).length;
    if (open !== close) bad.push(`${t}(+${open - close})`);
  }
  if (bad.length) fail(`G 标签不平衡：${bad.join(', ')}`);
  else pass(`G ${BLOCK_TAGS.length} 类块级标签全部平衡`);
}

// ── H Part 结构完整 ───────────────────────────────────────────
{
  const missing = PARTS.filter((p) => !h.includes(`id="${p}"`));
  if (missing.length) fail(`H Part 结构缺失：${missing.join(', ')}`);
  else pass(`H ${PARTS.length} 个 Part / Appendix 结构齐备`);
}

// ── I templates/ 与元语全集一致，且每份仍是模板 ─────────────
{
  const expected = [...CORE_META, ...COND_META, ...ENTRY_DOC].sort();
  let files;
  try {
    files = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    fail(`I templates/ 目录不存在或不可读：${TEMPLATE_DIR}`);
    files = null;
  }
  if (files) {
    if (files.length === 0) fail('I templates/ 无模板 —— 解析空转');
    const actual = [...files].sort();
    const missing = expected.filter((e) => !actual.includes(e));
    const extra = actual.filter((a) => !expected.includes(a));
    if (missing.length) fail(`I 模板缺失：${missing.join(', ')}`);
    if (extra.length) fail(`I 模板多余（不在元语全集内）：${extra.join(', ')}`);

    const structural = [];
    for (const name of actual) {
      const t = readFileSync(join(TEMPLATE_DIR, `${name}.md`), 'utf8');
      // 抬头块（MS-6）：标题行后须紧跟引用块
      if (!/^#\s.+\n\n>\s/m.test(t)) structural.push(`${name}: 缺抬头块`);
      // 格式契约附录 + 兜底规则（MS-8）—— 入口指针非元语，不要求
      if (!ENTRY_DOC.includes(name)) {
        if (!/##\s*附录：格式契约/.test(t)) structural.push(`${name}: 缺格式契约附录`);
        else if (!/解析为\s*0\s*行/.test(t)) structural.push(`${name}: 格式契约缺解析空转兜底规则`);
      }
      // 仍是模板：占位符未被填掉
      const ph = (t.match(/\{\{[^}]+\}\}/g) || []).length;
      if (ph < MIN_PLACEHOLDERS) structural.push(`${name}: 占位符仅 ${ph} 处（<${MIN_PLACEHOLDERS}）—— 疑似被填入实例内容`);
    }
    if (structural.length) fail(`I 模板结构不合规 —— ${structural.join(' · ')}`);
    if (!missing.length && !extra.length && !structural.length)
      pass(`I ${actual.length} 份模板与元语全集一致，结构合规且仍为模板`);
  }
}

report();
process.exit(problems.length ? 1 : 0);

function report() {
  for (const m of ok) console.log(`  ✓ ${m}`);
  for (const m of problems) console.error(`  ✗ ${m}`);
  console.log('━'.repeat(60));
  console.log(problems.length ? `✗ check-asfas-doc: ${problems.length} 项失败` : '✓ check-asfas-doc: 全部通过');
}
