#!/usr/bin/env node
// run-all.mjs — 校验器套件聚合入口
//
// 用法：node factory/verifiers/run-all.mjs <项目 adapter 路径>
//
// §25.8：单一命令跑全部校验器 · 秒级（慢闸门会被绕过）· 每个可单独执行 ·
//        共享解析层 · 退出码 0/非 0，**警告不影响退出码**。
// VC-9：本命令须被挂进项目的**默认测试命令**，不只是 CI 的独立任务 ——
//       反馈延迟是无人值守场景下漂移累积的主因。
// VC-3：格式契约先验必须**第一个**跑。

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { rejectFixFlag, summarize } from './lib/report.mjs';

import checkFormatContract from './checks/format-contract.mjs';
import checkDomain from './checks/domain.mjs';
import checkFlows from './checks/flows.mjs';
import checkDecisions from './checks/decisions.mjs';
import checkDeploy from './checks/deploy.mjs';
import checkAgents from './checks/agents.mjs';

rejectFixFlag();

const CHECKS = [
  ['格式契约先验', checkFormatContract],          // 必须第一个（VC-3）
  ['DOMAIN ↔ schema', checkDomain],
  ['FLOWS ↔ 状态写入', checkFlows],
  ['DECISIONS ↔ 代码 ID', checkDecisions],
  ['DEPLOY 三方对拍', checkDeploy],
  ['AGENTS 入口指针', checkAgents],
];

const adapterPath = process.argv[2] ?? './governance.adapter.mjs';
let adapter;
try {
  adapter = (await import(pathToFileURL(resolve(adapterPath)).href)).default;
} catch (e) {
  console.error(`✗ 无法加载项目适配器：${adapterPath}`);
  console.error(`  ${e.message}`);
  console.error('  参考 factory/verifiers/adapter.example.mjs');
  process.exit(2);
}
if (!adapter?.root || !adapter?.metaFiles) {
  console.error('✗ 适配器缺 root / metaFiles —— 见 adapter.example.mjs');
  process.exit(2);
}

const only = process.argv[3];                    // 可选：只跑某一项（便于负向验证定位）
const t0 = Date.now();
const results = [];
let formatFailed = false;

for (const [label, fn] of CHECKS) {
  if (only && !label.includes(only)) continue;
  // 格式契约失败时，后续内容检查的解析结果不可信 —— 停下，避免报出误导性的下游错误
  if (formatFailed) { console.log(`\n▸ ${label}\n  ⊘ 已跳过（格式契约先验失败，解析结果不可信）`); continue; }
  console.log(`\n▸ ${label}`);
  const r = fn(adapter);
  results.push(r.render());
  if (r.failed && fn === checkFormatContract) formatFailed = true;
}

console.log(`\n耗时 ${Date.now() - t0}ms`);
process.exit(summarize(results));
