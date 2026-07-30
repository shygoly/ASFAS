# factory/verifiers — 元语校验器套件（参考实现）

ASFAS 附录 D.2。把一个项目从 `C0`（元语齐备）带到 `C1`（漂移会报红）。

## 用法

```bash
# 1. 复制适配器模板到项目，按本项目技术栈实现
cp factory/verifiers/adapter.example.mjs <项目>/governance.adapter.mjs

# 2. 跑全套
node factory/verifiers/run-all.mjs <项目>/governance.adapter.mjs

# 3. 挂进项目的**默认测试命令**（VC-9），不只是 CI 的独立任务
#    "test": "node .../run-all.mjs ./governance.adapter.mjs && <原测试命令>"
```

无 `--fix`（`VC-2`）。退出码 0 = 全绿；非 0 = 有失败；**警告不影响退出码**。

## 架构：为什么校验器在工厂、适配器在项目

```
factory/verifiers/          与项目无关，只认元语的 schema（FINV-4）
  lib/       md · compare · scan · report      ← 共享解析层（§25.8）
  checks/    format-contract · domain · flows · decisions · deploy · agents
  run-all.mjs
  negative-harness.mjs                          ← 负向验证脚手架（VC-7/VC-8）

<项目>/governance.adapter.mjs                    ← **唯一接口**：代码侧事实由它提供
```

修一次校验器 bug 对所有项目生效；而"这个项目的 schema 长什么样"只有项目知道。
适配器**不 import 工厂内部模块**，只用标准库（`FR-14` 接口收窄）。

## 检查项

| 检查 | 对拍 | 关键点 |
|---|---|---|
| `format-contract` | 抬头块 · 格式契约附录 · 解析目标非空 · 链接 · 残留占位符 | **必须第一个跑**（`VC-3`）；它失败时后续检查会被跳过 —— 解析结果已不可信 |
| `domain` | 对象名集合相等 · 枚举**有序**相等 | 顺序敏感（`MS-20`）：`[low,medium,high]` 与 `[high,medium,low]` 是不同的类型 |
| `flows` | `states` == 枚举 · `from`/`to` ∈ `states` · **`impl` 状态级双向** · `via` 可解析 | 同一目标态被同时声明 yes/no = 矛盾（`MS-25`） |
| `decisions` | 引用的 ID ⊆ 在册（**红**）· 在册零引用（**WARN**） | 零引用不硬失败（`MS-31`）—— 纯业务决策可不落代码 |
| `deploy` | 文档 == 样例 == 代码（**三方**） | 两方对拍发现不了"两方都漏同一个键"；附反向枚举 |
| `agents` | 指针双向 · 无数字断言 · **不含契约段** | 最后一条是"检查某物**不存在**"（`FR-8`） |

## 负向验证（VC-7 / VC-8）

**未经负向验证的校验器不计入一致性证据**（`FR-3`）。`negative-harness.mjs` 提供脚手架：

```js
import { runNegativeSuite } from 'factory/verifiers/negative-harness.mjs';
runNegativeSuite({
  verifyCmd: ['node', 'factory/verifiers/run-all.mjs', './governance.adapter.mjs'],
  cases: [{ dim: 'DM-3 对象名', file: 'DOMAIN.md', mutate: (s) => s.replace('| `users`', '| `users_x`') }],
});
```

协议：**基线须绿**（否则一个恒红的校验器会"通过"每条用例）→ 工作区注入 → 须红且消息命中 →
回滚 → 须绿。用例失效时**显式报错，不静默跳过**。

## 在真实项目上验证时发现的三个自身缺陷

本套件首次在一个 `C2` 项目上运行时，报出 60+ 条问题，其中多数是**它自己的 bug**。
逐条定位后的三个教训已固化进代码注释与检查逻辑：

1. **默认忽略列表把源码目录跳过了。** `build` 既可能是构建产物目录，也可能是源码模块
   （`apps/api/src/build/`）。按 basename 无差别忽略 → 整个模块照不到 → 误报"某 env 键缺于代码"。
   修法：忽略列表分 `ALWAYS`（名字无歧义）与 `ROOT_ONLY`（有歧义，只在仓库根一层忽略）。
2. **共享解析层只认一种取值编码。** 真实项目用 `` `a` · `b` `` 而非 `[a, b]`，
   于是整张枚举表被解析成 0 项，下游误判成"文档漏登记 23 项"。
   修法：`valueList()` 兼容两种编码；表分类改按**小节标题**而非猜行内容。
3. **示例适配器的启发式两个方向都出错。** 窗口法找状态写入点，误报 21 条"impl:yes 但无写入点"
   + 2 条"impl:no 但有写入点"。修法：默认实现一律返回 `null`（无法判定 → 警告），
   **判定需要项目的实际写法知识，这正是适配器存在的理由**。

第三条是最重要的：**假阳性比没有检查更坏 —— 它教人"红是常态"（`FINV-8`），随后整个闸门被忽略。**
