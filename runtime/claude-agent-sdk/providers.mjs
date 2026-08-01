// providers.mjs — 角色 → 模型供应商的路由表（Claude Agent SDK 绑定内部）
//
// ## 为什么路由必须落在"每次 query() 的 env"上，而不是 SDK 的 agent 配置里
//   Claude Agent SDK 没有 per-agent 的供应商路由：`AgentDefinition.model` 只是模型名，
//   `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 由 CLI 子进程读取，**进程级**。
//   唯一的杠杆是 `options.env`——每次 query() 起一个子进程，env 可逐次替换。
//
//   推论：worker MUST NOT 实现为 supervisor 的 SubAgent（同一子进程 = 同一供应商）。
//   而 ASFAS 独立地要求同一形状：`RT-14` 会话边界=活动边界、`RT-16` 跨角色派工用独立实例 +
//   handoff、`RT-17` SubAgent 不得跨活动边界。SDK 的物理限制与规范的治理要求指向同一个设计。
//
// ## 真实值只进 .env（已 gitignore），本文件只登记键位
//   与被治理项目的 DEPLOY 元语同一纪律：样例文件与代码只出现键名，不出现真值。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = join(HERE, '..', '..');

/** 供应商登记表。base_url / auth_token 只登记**键位**，取值在 .env。 */
export const PROVIDERS = Object.freeze({
  zai: { base_url_key: 'ZAI_BASE_URL', auth_token_key: 'ZAI_AUTH_TOKEN' },
  deepseek: { base_url_key: 'DEEPSEEK_BASE_URL', auth_token_key: 'DEEPSEEK_AUTH_TOKEN' },
});

/**
 * 角色 → 供应商 + 模型。
 * 角色名 MUST 与能力注册表一致（`MS-37`）——本表只做路由，不定义身份。
 * `default` 是兜底：新角色入册时若忘了加路由，走默认而不是静默失败。
 */
export const ROUTES = Object.freeze({
  // 全角色统一 deepseek-v4-flash（1M 上下文，thinking 默认启用）。
  // 见 DeepSeek 定价页 / Anthropic 兼容端点 api.deepseek.com/anthropic。
  supervisor: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
});

/** 极简 .env 读取。零依赖（`mem:tech_stack`：本仓不引入任何 dependency）。 */
function loadDotEnv() {
  const p = join(FACTORY_ROOT, '.env');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 解析角色的供应商配置。
 * @returns {{provider:string, model:string, baseUrl:string, authToken:string}}
 * @throws {Error} 带 `class` 字段的配置错误——调用方据此映射到 `§35.3` 的错误分类
 */
export function resolveProvider(role, env = { ...loadDotEnv(), ...process.env }) {
  const route = ROUTES[role] ?? ROUTES.default;
  const spec = PROVIDERS[route.provider];
  if (!spec) {
    const e = new Error(`路由表把角色 ${role} 指向未登记的供应商 ${route.provider}`);
    e.class = 'runtime_fault';                       // 适配器自身配置缺陷，不是活动的错
    throw e;
  }
  const baseUrl = env[spec.base_url_key];
  const authToken = env[spec.auth_token_key];
  const missing = [!baseUrl && spec.base_url_key, !authToken && spec.auth_token_key].filter(Boolean);
  if (missing.length) {
    // fail-closed（`FP-4`）：没有凭证就明确报缺配置，MUST NOT 静默回落到别的供应商——
    // 静默回落会让"这次活动跑在哪个模型上"变得不可回答，直接毁掉血缘的可归属性。
    const e = new Error(`角色 ${role} → 供应商 ${route.provider}：.env 缺 ${missing.join(', ')}`);
    e.class = 'capability_missing';
    throw e;
  }
  return { provider: route.provider, model: route.model, baseUrl, authToken };
}

/**
 * 需要从继承环境中**剔除**的变量。
 *
 * 这不是洁癖，是实测出来的静默失效路径：工厂若跑在一个 Claude Code 会话内部，父进程环境里带着
 * `CLAUDECODE=1`、`CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`、`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`。
 * 这些一旦被子进程继承，子 CLI 会改用**宿主 keychain 里的凭证**，而不是这里设的
 * ANTHROPIC_AUTH_TOKEN —— base_url 照样按路由走，token 却换了人。
 *
 * 表现是 401，但**危险的不是 401**：若宿主凭证恰好对该端点有效，活动会静默跑在错误的
 * 账户/模型上，而血缘记录的是路由表里那个。血缘失真远比报错严重，故按前缀整体清空后再设回三项。
 */
const STRIP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_'];
const STRIP_EXACT = ['CLAUDECODE', 'AI_AGENT'];

/**
 * 构造子进程 env。
 * 注意 SDK 的 `options.env` 是**替换**而非合并，所以必须显式带上继承项（PATH / HOME 等），
 * 否则子进程连 node 都找不到。
 */
export function buildEnv(resolved, baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (STRIP_EXACT.includes(k)) continue;
    if (STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = resolved.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = resolved.authToken;
  env.ANTHROPIC_MODEL = resolved.model;

  // auto memory（`~/.claude/projects/<project>/memory/`）**无视 settingSources**，
  // 官方 Hosting 文档明写它会直接进 system prompt。它是跨会话的知识注入，
  // 正面撞 `AG-3`（智能体 MUST NOT 跨会话持有项目知识，每次实例化 MUST 从元语重新加载），
  // 也绕过 `RT-13` 的工具面收窄——关掉它是必需项，不是加固项。
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}
