// compare.mjs — 对拍原语
//
// ASFAS §25.2 定义四种对拍形态。本模块实现前三种；
// 第四种（双向存在性）依赖代码侧扫描，见 checks/flows.mjs。
//
// VC-4：对拍必须双向。单向子集检查不计为对拍 —— 它发现不了文档登记了代码里没有的
// 死条目，而智能体读到不存在的表名会基于它写代码。

/**
 * 集合相等（双向）。
 * 返回 { ok, missing（文档缺，代码有）, extra（文档有，代码缺=死条目） }
 */
export function setEqual(docSet, codeSet) {
  const d = new Set(docSet), c = new Set(codeSet);
  const missing = [...c].filter((x) => !d.has(x)).sort();
  const extra = [...d].filter((x) => !c.has(x)).sort();
  return { ok: !missing.length && !extra.length, missing, extra };
}

/**
 * 有序相等（MS-20）。
 * 枚举在数据库中不是集合而是**有序类型**：声明顺序决定比较与排序语义。
 * [low, medium, high] 与 [high, medium, low] 是不同的类型，会让 > 得出相反结果。
 * 把它当集合检查是一个语义假绿（PS-3 第一类）。
 */
export function orderedEqual(docSeq, codeSeq) {
  const a = [...(docSeq ?? [])], b = [...(codeSeq ?? [])];
  if (a.length === b.length && a.every((v, i) => v === b[i])) return { ok: true };
  const sameSet = setEqual(a, b).ok;
  return {
    ok: false,
    sameSet,                       // true = 取值相同但**顺序不同**，这是最容易被放过的情形
    doc: a, code: b,
  };
}

/** 子集（用于 declares ⊆ 候选集、ID ⊆ 在册集 这类单向约束） */
export function subsetOf(sub, sup) {
  const s = new Set(sup);
  const outside = [...new Set(sub)].filter((x) => !s.has(x)).sort();
  return { ok: !outside.length, outside };
}

/** 三方相等（DEPLOY env 键位，MS-32）。两方对拍发现不了"两方都漏同一个键"。 */
export function tripleEqual(named) {
  const names = Object.keys(named);
  const sets = names.map((n) => new Set(named[n]));
  const union = new Set(names.flatMap((n) => named[n]));
  const problems = [];
  for (const key of [...union].sort()) {
    const has = names.filter((n, i) => sets[i].has(key));
    if (has.length !== names.length) {
      const miss = names.filter((n) => !has.includes(n));
      problems.push({ key, presentIn: has, missingFrom: miss });
    }
  }
  return { ok: !problems.length, problems };
}

/** 把对拍结果渲染成一行可读消息 */
export function describe(label, r) {
  if (r.ok) return null;
  if (r.missing || r.extra) {
    const bits = [];
    if (r.missing?.length) bits.push(`文档缺 ${r.missing.length} 项：${r.missing.slice(0, 8).join(', ')}${r.missing.length > 8 ? ' …' : ''}`);
    if (r.extra?.length) bits.push(`文档多 ${r.extra.length} 项（死条目）：${r.extra.slice(0, 8).join(', ')}${r.extra.length > 8 ? ' …' : ''}`);
    return `${label} —— ${bits.join('；')}`;
  }
  if (r.doc && r.code) {
    return r.sameSet
      ? `${label} —— 取值相同但**顺序不同**（枚举顺序敏感，MS-20）：文档 [${r.doc.join(', ')}] vs 代码 [${r.code.join(', ')}]`
      : `${label} —— 文档 [${r.doc.join(', ')}] vs 代码 [${r.code.join(', ')}]`;
  }
  if (r.outside?.length) return `${label} —— 越界 ${r.outside.length} 项：${r.outside.slice(0, 8).join(', ')}`;
  if (r.problems?.length) {
    return `${label} —— ${r.problems.slice(0, 8).map((p) => `\`${p.key}\` 缺于 ${p.missingFrom.join('/')}`).join('；')}${r.problems.length > 8 ? ' …' : ''}`;
  }
  return label;
}
