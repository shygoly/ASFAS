// md.mjs — 共享 markdown 解析层
//
// ASFAS §25.8：解析层必须共享。解析不一致会导致同一份文档在不同校验器眼中不同 ——
// 那会产生一类无法定位的假绿：A 检查器看到 3 行，B 检查器看到 2 行，两者都"通过"。
//
// 本模块不含任何项目知识（FINV-4）。

/** 去掉行首引用块标记与首尾空白 */
const clean = (s) => s.replace(/^\s*>\s?/, '').trim();

/**
 * 解析文档中的全部 markdown 表格。
 * 返回 [{ heading, headers, rows }]，rows 为二维字符串数组（未去 markdown 标记）。
 * heading 是该表所属的最近一个 ## / ### 标题原文（用于按小节定位）。
 */
export function parseTables(text) {
  const lines = text.split('\n');
  const tables = [];
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{2,4}\s+(.*)$/);
    if (h) { heading = h[1].trim(); continue; }

    // 表头行 + 分隔行
    if (!/^\s*\|/.test(lines[i])) continue;
    const sep = lines[i + 1];
    if (!sep || !/^\s*\|[\s:|-]+\|\s*$/.test(sep)) continue;

    const headers = splitRow(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows.push(splitRow(lines[j]));
    tables.push({ heading, headers, rows });
    i = j - 1;
  }
  return tables;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 取单元格中被反引号包裹的第一个 token；无则返回 null */
export function backticked(cell) {
  const m = String(cell).match(/`([^`]+)`/);
  return m ? m[1] : null;
}

/** 取单元格中全部被反引号包裹的 token */
export function allBackticked(cell) {
  return [...String(cell).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** 解析形如 `[a, b, c]` 的有序列表；顺序保留（DOMAIN 枚举取值顺序敏感，MS-20） */
export function bracketList(cell) {
  const m = String(cell).match(/\[([^\]]*)\]/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);
}

/**
 * 解析取值列表，兼容两种真实存在的编码，**顺序保留**：
 *   ① `[a, b, c]`              —— 方括号列表
 *   ② `` `a` · `b` · `c` ``    —— 反引号 token + 分隔符（· , 、 /）
 * 返回 null 表示"这不是取值列表"。
 *
 * 两种都支持是必要的：格式契约由**各项目的元语自己声明**，共享解析层
 * 若只认一种，就会把另一种编码的文档解析成 0 项 —— 而 0 项会被
 * 下游误判成"文档漏登记"，产生大量假阳性（本模块在真实项目上首次运行时即踩中此坑）。
 */
export function valueList(cell) {
  const bracket = bracketList(cell);
  if (bracket) return bracket;
  const toks = allBackticked(cell);
  if (toks.length < 2) return null;                    // 单 token 不足以判定为列表
  const stripped = String(cell).replace(/`[^`]+`/g, '').trim();
  if (!/^[\s·,、/|]*$/.test(stripped)) return null;    // token 之间只允许分隔符
  return toks;
}

/** 解析指定语言的围栏代码块，返回内容数组 */
export function fencedBlocks(text, lang) {
  const re = new RegExp('```' + lang + '\\r?\\n([\\s\\S]*?)```', 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
}

/**
 * 解析 FLOWS.md 的 flow 块。
 * 返回 { machine, enum, states, initial, transitions:[{from,to,via,by,inv,impl,raw}], bad:[原始行] }
 * 五段不全的行进 bad —— 由调用方判红（MS-24），本层不做策略判断。
 */
export function parseFlowBlock(body) {
  const out = { machine: null, enum: null, states: null, initial: null, transitions: [], bad: [] };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^machine:\s*(.+)$/))) { out.machine = m[1].trim(); continue; }
    if ((m = line.match(/^enum:\s*(.+)$/))) { out.enum = m[1].trim(); continue; }
    if ((m = line.match(/^states:\s*(.+)$/))) { out.states = bracketList(m[1]); continue; }
    if ((m = line.match(/^initial:\s*(.+)$/))) { out.initial = m[1].trim(); continue; }
    if (!line.startsWith('-')) continue;

    // - from → to | via: X | by: Y | inv: Z | impl: yes|no
    const t = line.replace(/^-\s*/, '');
    const parts = t.split('|').map((s) => s.trim());
    const arrow = parts[0]?.match(/^(\S+)\s*(?:→|->)\s*(\S+)$/);
    const get = (k) => {
      const p = parts.find((x) => x.toLowerCase().startsWith(k + ':'));
      return p ? p.slice(k.length + 1).trim() : null;
    };
    const via = get('via'), by = get('by'), inv = get('inv'), impl = get('impl');
    if (!arrow || via === null || by === null || inv === null || impl === null) { out.bad.push(line); continue; }
    if (impl !== 'yes' && impl !== 'no') { out.bad.push(line); continue; }
    out.transitions.push({ from: arrow[1], to: arrow[2], via, by, inv, impl, raw: line });
  }
  return out;
}

/** 提取文档中的相对路径链接 [text](path)，忽略 http(s) 与纯锚点 */
export function relativeLinks(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => m[1].split('#')[0].trim())
    .filter((p) => p && !/^https?:/.test(p) && !p.startsWith('mailto:'))
    .filter((p) => !/['"]/.test(p))              // 排除含引号的（代码示例如 [.get]('KEY') 假阳性）
    .filter((p) => !(p.includes('(') && !p.endsWith(')'))); // 排除括号被截断的（Next.js (console) 路径）
}

/**
 * 按词边界提取 ID。前缀集合由调用方给出（不同项目命名空间不同）。
 * 词边界很重要：否则 INV-1 会匹配到 INV-12（附录 B.2）。
 */
export function extractIds(text, prefixes) {
  if (!prefixes.length) return [];
  const alt = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_-])((?:${alt})-[A-Za-z0-9]+(?:\\.[0-9]+)?)(?![A-Za-z0-9_])`, 'g');
  return [...new Set([...text.matchAll(re)].map((m) => m[1]))].filter((id) => !isIdPlaceholder(id));
}

/**
 * 形如 `D-x` / `INV-n` / `F-n` 的是**文档在讲 ID 的写法**，不是 ID 引用。
 * 校验器与元语文档本身大量出现这类占位（"代码里写 `D-x` 标记必须先在册"），
 * 不排除会产生成片假阳性。
 * 判据：后缀是单个小写字母，或 n/m/k/x 的重复（n, nn, xxx…）。
 */
export function isIdPlaceholder(id) {
  const suffix = id.slice(id.indexOf('-') + 1);
  return /^[a-z]$/.test(suffix) || /^(?:n|m|k|x)\1*$/.test(suffix) || /^[nmkx]{1,3}$/.test(suffix);
}

/** 是否存在「附录：格式契约」小节且含解析空转兜底（MS-8） */
export function hasFormatContract(text) {
  if (!/##\s*附录：格式契约/.test(text)) return { ok: false, why: '缺「附录：格式契约」小节' };
  if (!/解析为\s*0\s*行/.test(text)) return { ok: false, why: '格式契约缺解析空转兜底规则' };
  return { ok: true };
}

/** 元语中不应残留模板占位符（MS-46） */
export function leftoverPlaceholders(text) {
  return [...new Set([...text.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]))];
}

export { clean };
