# verifiers — factory/verifiers 校验器套件（参考实现）

ASFAS 附录 D.2。把被治理项目从 `C0` 带到 `C1`。详见 `factory/verifiers/README.md`。

## 架构分层

```
factory/verifiers/
  lib/      md · compare · scan · report      ← 共享解析层（§25.8），不含任何项目知识（FINV-4）
  checks/   format-contract · domain · flows · decisions · deploy · agents
  run-all.mjs                                ← 聚合入口
  negative-harness.mjs                       ← 负向验证脚手架（VC-7/VC-8）
  adapter.example.mjs                        ← 复制到项目改名为 governance.adapter.mjs
```

**唯一接口**：项目侧 `<项目>/governance.adapter.mjs`（default export 一个对象）。工厂只调适配器提供的方法（`schemaObjects()` / `stateHasWriter()` / `envReads()` / `guardResolves()` 等），返回 `null` = 该维度不适用 → 跳过且计入警告（**跳过必须可见**，`PS-3` 静默跳过是假绿）。

## VC 契约（VC-1..VC-9，校验器自身须遵守，且每个有负向验证）

- **VC-1 确定性** · **VC-2 只诊断无 `--fix`**（`rejectFixFlag()`，传入即退出码 2）· **VC-3 格式契约先验**（`format-contract` 必须第一个跑；它失败则后续检查的解析结果不可信，全部跳过）
- **VC-4 双向对拍**（`setEqual`/`orderedEqual`/`tripleEqual`；单向子集发现不了死条目）· **VC-5 面向工作区**（直接读磁盘）· **VC-6 扫描面显式声明 + 反向枚举**
- **VC-7/VC-8 负向验证**（未经负向验证的校验器不计入一致性证据，`FR-3`）· **VC-9 须挂进项目默认测试命令**（不止 CI）

## 六检查（顺序即 run-all.mjs 的 CHECKS 数组，不可乱序）

| 文件 | 维度前缀 | 要点 |
|---|---|---|
| `format-contract.mjs` | `FC-` | 必须第一个；解析空转=红；AGENTS 不要求格式契约附录 |
| `domain.mjs` | `DM-` | 对象名集合相等；枚举**有序**相等（`MS-20`）；表分类按**小节标题**不猜行 |
| `flows.mjs` | `FL-` | `impl` 是**状态级**语义不是转移级（`MS-25`）；同一目标态同时 yes/no=矛盾 |
| `decisions.mjs` | `DC-` | 引用 ID ⊆ 在册=红；在册零引用=**WARN 不红**（`MS-31`） |
| `deploy.mjs` | `DP-` | 文档/样例/代码**三方**对拍（`MS-32`）；扫描面须含前端构建配置 |
| `agents.mjs` | `AG-` | 指针双向；最后一条是"检查某物**不存在**"（`FR-8`） |

## Reporter / 退出码

`lib/report.mjs`：`createReporter(name)` → `.pass(m)` / `.fail(dim,msg)` / `.warn(dim,msg)`。
`summarize(results)` → 退出码 0 全绿 / 非 0 有失败，**警告不影响退出码**。
错误消息须含维度标识 + 位置（`§25.3`），否则智能体会随机试探。

## 写校验器代码须记住的坑（已固化进注释，别重蹈）

1. 忽略列表分 `ALWAYS`（`build`/`dist` 无歧义）与 `ROOT_ONLY`（有歧义只在仓库根一层忽略）—— 否则把源码模块当产物跳过，整模块照不到（误报）。
2. `valueList()`（lib/md.mjs）必须**同时兼容** `` `a` · `b` `` 与 `[a,b]` 两种编码 —— 只认一种会把整张表解析成 0 项 → 下游误判漏登记。
3. 适配器默认实现一律返回 `null`（无法判定 → 警告，不判红）—— **假阳性比没有检查更坏**（`FINV-8`：教会人"红是常态"，闸门被忽略）。
