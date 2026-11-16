# DSH DAG 插件

面向 **DeepSeek Harness `0.2.2-rc.1`** 的两种 DAG 执行模式。包名为 `@sasimoreyang-ai/dsh-dag`，版本 `0.2.0-rc.1`。

| 模式 | 入口 | 谁决定图 | 一次模型步是什么 |
| --- | --- | --- | --- |
| **工具臂** `dag_execute` | `@sasimoreyang-ai/dsh-dag` | 模型在工具调用里提交节点与依赖 | 原生 ReAct 步 + 一次图执行 |
| **编译器臂** `dag-compiler` | `@sasimoreyang-ai/dsh-dag/compiler` | 插件把模型的这次调用整个换成 planner → 图 → joiner | 编译出来的一整个任务图 |

两个插件可以同时安装，互不干扰：工具臂是模型主动调用，编译器臂是接管外层 loop 的模型调用。

## 版本对齐

本仓库按 DSH 版本分分支，**不要混用**：

| 分支 | DSH 版本 | cordis | 说明 |
| --- | --- | --- | --- |
| **`main`** | **`0.2.2-rc.1`** | `~4.1.0` | 主线：工具臂 + 编译器臂 |
| `feat/llmcompiler-dag` | `0.2.1-alpha.2` | `~4.0.5-alpha.1` | 同一套实现，对齐参考实现（LLMCompiler × ParallelQA）实际跑过的 DSH 版本 |
| `dsh-0.2.0-rc.2`（归档） | `0.2.0-rc.2` | `~4.0.4` | 主线迁移前的状态，只有工具臂 |

所有 DSH peer dependency 都锁在对应版本；`peerDependencies` 与 `devDependencies` 的版本必须同步改，否则 `npm install` 会因 peer 冲突失败。

### 0.2.2-rc.1 的破坏性变化与主线的适配

`0.2.2-rc.1` 重做了工具派发链路，编译器引擎本身没有改动，适配都在边界上：

| `dsh-tools` 变化 | 影响 | 主线的做法 |
| --- | --- | --- |
| `tools.execute` 由单调用变批量：`ToolBatchInput { calls: ToolCallBlock[], signal, agent?, toolSet?, log? }` → `ToolBatchResult { results, additionalContexts, concluded }`；`ToolCallBlock.arguments` 是**模型产出的 JSON 字符串** | 图节点与计划任务都不能再单发 | 一个节点/任务 = 一次批量为 1 的调用，参数 `JSON.stringify` 后放入 `arguments` |
| 执行被委派给外部 `ToolExecutor`：未 `setExecutor` 时 `tools.execute` 抛 `ToolExecutorUnavailableError` | 测试与基准脚本原本直接派发，现在需要执行器 | 真实 profile 由 agent loop 提供；测试与 benchmark 通过 `@deepseek-ai/dsh-tools/pipeline` 装载公开管线（`tests/fixtures/executor.mjs`） |
| `tools.executionMode` 从 service 移到 `ToolExecutionPipeline` | 工具臂调度分类失效 | 改为读工具定义的 `isConcurrencySafe`（与管线自身的分类规则同源） |
| `ToolExecutionInput` 保留但不再由注册表直接消费；嵌套派发不再携带 `rootCallId` / `parent` 令牌 | 图内节点拿不到外层 correlation id | 由执行器拥有关联信息；`agent` 与 `additionalContexts` 仍照常传递 |
| `register(definition, options?: { when })`、`get(name, scope?, toolSet?)` 新增 `toolSet` 概念 | 条件注册的工具需要本步准入集才可见 | 本插件的工具都不条件注册，未使用 `toolSet` |
| 移除 `presentAs` / PTC 呈现模式 / `./invariant` 伴随插件 | — | 本插件未依赖这些接口；无流文法校验器，故编译器臂仍按参考实现只发 `text-delta` / `usage` / `finish` |

引擎行为、prompt 与解析语义与 `feat/llmcompiler-dag`（0.2.1-alpha.2）分支**完全相同**，两条线的代码差异只在上面这张表里。

## 安装

需要 Node.js 22+、npm 和对应版本的 DSH。

```sh
git checkout main                        # 0.2.2-rc.1；或 feat/llmcompiler-dag（0.2.1-alpha.2）
npm ci
npm test
npm pack
dsh plugin --profile web add ./sasimoreyang-ai-dsh-dag-0.2.0-rc.1.tgz
dsh --profile web --dump-config
```

合成配置中应出现 `id: tool-dag`。编译器臂默认**不**注册，需自行追加（见下）。

> **切分支后必须重装依赖。** 两个分支锁定的 DSH 版本不同，而 `node_modules` 只有一份。切换分支后先 `rm -rf node_modules package-lock.json && npm install`，否则会用错版本的类型编译，表现为 `'calls' does not exist in type 'ToolExecutionInput'` 这类报错。

本项目通过 `dsh.bundle.patch` 注册插件，工具通过 Cordis 的 `tools` 服务挂载。GitHub 源码需要先编译并打包，npm registry 的包名安装待 npm 发布后可用。

## 工具臂：`dag_execute`

模型调用 `dag_execute` 提交节点、工具参数和依赖关系。插件在依赖满足后调度节点，独立且声明并发安全的工具可以同时执行。原生 Agent 负责规划、理解结果与后续决策。

向 Agent 提出适合分解的任务，例如“请用 dag_execute 并行读取 README.md 和 package.json，再汇总项目用途与启动方法”。模型需要能看到 `dag_execute` 和计划调用的工具。

```json
{
  "nodes": [
    { "id": "readme", "tool": "read", "arguments": { "file_path": "README.md", "limit": 80 } },
    { "id": "package", "tool": "read", "arguments": { "file_path": "package.json", "limit": 80 } }
  ],
  "failurePolicy": "continue"
}
```

每个节点包含 `id`、`tool`、`arguments`，可选 `dependsOn`。节点 ID 允许 1–64 个英文字母、数字、下划线和连字符。工具名必须已注册且对当前 Agent 可见。参数有明确先后关系时应通过 `dependsOn` 表达，尤其是写入、读取同一文件等操作。

### 引用上游结果

在参数的任意位置使用 `{"$dagRef":{"node":"上游ID","pointer":"/字段路径"}}`。引用整个值时 `pointer` 使用空字符串。JSON Pointer 支持 `~0` 表示 `~`、`~1` 表示 `/`。

```json
{
  "nodes": [
    { "id": "head", "tool": "read", "arguments": { "file_path": "README.md", "limit": 10 } },
    { "id": "tail", "tool": "read", "dependsOn": ["head"],
      "arguments": { "file_path": { "$dagRef": { "node": "head", "pointer": "/path" } }, "offset": 11, "limit": 10 } }
  ]
}
```

每个引用的节点必须列入 `dependsOn`。引用使用工具经 DSH 执行管线处理后的 canonical value，具体字段由该工具的输出契约决定。动态字段不存在或参数类型不匹配时，该节点失败，其后继节点阻塞。`$dagRef` 为保留字段。

### 调度、权限和失败

- 全图先校验节点、依赖、环、工具可见性及无引用节点的参数。校验失败时返回工具错误。
- 依赖完成即可调度后继节点。并发数由 `maxConcurrency` 限制。
- 只有 DSH 判定并发安全的调用能够重叠。其他调用独占执行，并形成调度屏障。图外仍由 DSH 的原生调度器管理。
- 每个节点通过工具注册表调用，继承原 Agent、取消信号，经过原生权限、审批、沙箱与结果策略。
- `continue` 为默认失败策略，继续执行独立分支。`stop` 在失败后停止派发排队节点，等待在途调用结束。
- 节点状态包括 `succeeded`、`failed`、`blocked`、`cancelled` 和 `skipped`。检查节点状态后再决定下一轮计划。已成功的写入会保留，重试需要结合返回状态判断。
- 超时、用户取消和插件卸载会取消正在运行的调用，并等待它们完成清理。
- 子工具的附加上下文和 `concludesTurn` 会传递给原生 Agent。结束回合后停止派发剩余节点。
- 直接及经其他工具间接递归调用 DAG 均被拒绝。

## 编译器臂：`dag-compiler`

把 **LLMCompiler** 的图编排做成 Agent 本体，而不是一个工具。插件挂 `llm/stream` waterfall：当请求是外层 agent loop 自己发起的那次模型调用时，用编译器整段替换模型流。

```text
外层 loop
   │  一次模型调用
   ▼
llm/stream waterfall
   │
   ├─ Planner      1 次模型调用：把问题编译成带 $id 依赖的任务 DAG
   ├─ Task Fetching Unit  贪心派发「依赖已满足」的任务，替换 $id
   ├─ Executor     同波并发执行，工具经 DSH 工具注册表
   └─ Joiner       1 次模型调用：Finish(answer) 或 Replan(reason)
   │
   ▼
合成的 assistant 消息（text-delta / usage / finish）
```

因此这一轮**外层零次真实模型调用**，而 session 日志、回合生命周期、headless NDJSON 投影、权限与审批、结果策略全部仍走 DSH 原生机制。

### 启用

编译器臂会改变该 profile 的每一轮产出，因此**不**在默认 patch 中；需要显式加入 `cordis.patch.yml`：

```yaml
- insert:
    - id: dag-compiler
      name: '@sasimoreyang-ai/dsh-dag/compiler'
      config:
        provider: volcano
        model: deepseek-v4.1-flash
        temperature: 0
        maxTokens: 4096
        maxReplans: 1
        maxParallel: 8
```

仓库内的 `cordis.patch.compiler.yml` 就是这段配置的样例（含 ParallelQA 用的路由）。

### 配置

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `provider` / `model` | 必填 | planner 与 joiner 的路由；外层 loop 的路由由 DSH 自己决定 |
| `reasoningEffort` | 不传 | 传给 planner/joiner 的推理档位。不传时按适配器默认（DeepSeek 方言下等于关闭思考，与参考实现一致） |
| `temperature` | `0` | 采样温度 |
| `maxTokens` | `2048` | planner/joiner 单次上限（参考实现的代码默认值；其 ParallelQA overlay 用 4096） |
| `maxReplans` | `1` | 重规划轮数；总计划轮数为 `maxReplans + 1` |
| `maxParallel` | `0` | 单个 ready 波内并发上限；`0` = 整波一次发出（参考实现的做法） |
| `maxToolOutputChars` | `0` | 喂给 joiner 与下一轮计划的观测长度上限；`0` = 不截断（参考实现的做法） |
| `tools` | ParallelQA 的 `search` / `math` | planner 可见的工具词汇（名字、描述块、位置参数名） |
| `plannerPrompt` / `joinerPrompt` | 内置 | 覆盖内置 prompt（默认值见下） |
| `detect` | `heuristic` | 接管判据：`heuristic`=参考实现的结构启发式（默认）；`marker`=只认 loop 官方标记；`either`=两者取或 |
| `emptyAnswer` | `diagnostic` | 编译没产出答案时怎么办：`diagnostic` 在 assistant 文本里说明；`error` 以 `DAG_COMPILER_EMPTY_ANSWER` 失败 |
| `metricsPath` | 不设置 | 可选 JSONL，逐轮落一条引擎记录 |
| `callIdPrefix` | `dag` | 派发时构造 call id 的前缀 |
| `trace` | `true` | 向 host 日志输出 `dag.compiler.trace` 结构化记录 |

`tools` 的每一项是 `{ name, description, parameters, coerce }`：`description` 原样进入 planner system prompt，`parameters` 按位置映射成工具 JSON 参数（缺省的位置参数会整键省略——`context: undefined` 会被注册表拒绝），`coerce` 默认 `string`，与参考实现把位置参数转成文本的行为一致。

### 与参考实现的一致性

编译器臂是 `liuyang1271/notes` 中 [bench-parallelqa-dag](https://gitcode.com/liuyang1271/notes/blob/master/src/bench-parallelqa-dag/README.md)（`dsh-demo/engine.mjs` + `dsh-demo/plugin-dag.mjs`）的移植，而后者是 `third_party/LLMCompiler` 的移植。为便于逐项核对，本实现：

- **prompt 逐字节一致**：planner（首轮/重规划）与 joiner 三段文本（含 upstream 那个「列 3 个动作、头部写 4 types」的 off-by-one、五组 few-shot、`OUTPUT_PROMPT` 全文）与参考实现 sha256 相同，`tests/compiler.test.mjs` 固化了这三个哈希；
- **解析/调度语义一致**：`parseArgs` 模拟 `ast.literal_eval`、`$id` 依赖推断、`join` 依赖全部前序任务且遇 join 即止、`<END_OF_PLAN>` 剥离、贪心波次、joiner `Action:` 行严格解析与 `tolerantAnswer` 兜底；
- **控制流一致**：planner 空计划重试 1 次、joiner 无 action 行重试 1 次、计划轮数 `maxReplans + 1`、空计划仍以空 scratchpad 调 joiner、重规划把上一轮 `Previous Plan` + 观测 + Thought 拼回 planner；
- **派发一致**：一个计划任务 = 一次工具调用，走 DSH 工具注册表（权限、审批、沙箱、结果策略照常生效）。

有意的差异，只有下面这些：

| 项 | 参考实现 | 本实现 | 原因 |
| --- | --- | --- | --- |
| 工具词汇 | 硬编码 `search` / `math` | `tools` 配置，默认值逐字等于参考实现；未在配置里描述的工具名仍按参考实现的规则构造参数（`search` → `{entity}`，其余 → `{problem, context?}`）并**照常派发**，由注册表拒绝 | 让插件能用于别的工具集，同时保持默认可比、未知工具行为一致 |
| 计划外增补 | — | `plannerPrompt` / `joinerPrompt` 可覆盖；`emptyAnswer` 在编译无答案时给诊断或失败 | 纯插件边界行为，引擎与 prompt 默认值不受影响 |
| agent 归属 | 不传 | 用请求的 `sessionId` 从 live registry 解析出 Agent 并随派发传入 | 宿主必需：不传则按 agent 作用域可见的工具无法被图调用 |

### 无头运行（headless）

`dsh --profile headless "<task>"` 会把**这一轮的 assistant 文本**写到 stdout，所以编译器的产出必须是一段文本：

- 正常路径：joiner 的 `Finish(answer)` 里的 answer 就是这轮的回答。
- **无答案时不会再静默**：planner 没给出任务、joiner 也没给出 `Finish/Replan` 时，默认（`emptyAnswer: diagnostic`）会输出一段说明，例如
  `dag-compiler produced no answer (0 plan tasks, 3 model calls); joiner said: ...`；
  配 `emptyAnswer: error` 则以 `DAG_COMPILER_EMPTY_ANSWER` 失败。改成诊断而不是空字符串，是因为无头场景下空文本会被当成"成功但没内容"。
- **thinking 模型要注意**：planner/joiner 若让模型把预算花在思考上、content 返回空，就会走到上面那条无答案路径。显式配 `reasoningEffort: 'off'`（或调大 `maxTokens`）可避免；参考实现在 DeepSeek 方言下正是靠适配器默认关思考才拿到干净 content。
- **验证通道**：host logger 不一定会把 `dag.compiler.trace` 落到 stderr。要看"这一轮到底有没有被编译"，配 `metricsPath: /path/engine.jsonl`，引擎会逐轮追加一条记录（含 planner/joiner 耗时、任务数、波数、重规划次数、answer）。

```yaml
- id: dag-compiler
  disabled: false
  config:
    provider: <route>
    model: <model>
    reasoningEffort: 'off'
    metricsPath: /var/log/dsh/dag-compiler.jsonl
```

### 已知边界

- **planner 和 joiner 是两次额外模型调用**。参考实现在 ParallelQA（113 题、2–4 波、平均 8 个任务/题）上四臂统一关思考时比原生 loop 快 1.30×；在单层 DAG 上反而更慢（HotpotQA 4.36 s vs 7.59 s）。收益取决于任务形态与「省下的决策往返能否覆盖这两次调用」，不要当成通用加速。
- **一轮只产出一条答案**，不承载工具调用：编译器在 loop 眼里是「一次纯文本模型响应」。工具中间结果的 `additionalContexts` 与 `concludesTurn`（本宿主挂在 `ToolRunContext` 上）无法回传。
- **planner/joiner 的思考档位由适配器决定**。参考实现的快有相当部分是关掉 planner/joiner 思考换来的，见 notes 里 AISBench 那组 `resolved 95% / 60% / 75%` 的消融。
- **工具词汇默认是 ParallelQA 的 `search`/`math`**，直接用于编码类 profile 需要自己配 `tools` 与 `plannerPrompt`。
- 编译器臂会接管**每一次** loop 模型调用，没有 per-turn 的白名单；`detect` 与 `tools` 是唯一的收窄手段。
- 递归防护用 `AsyncLocalStorage`：编译过程中被派发的工具若再触发模型调用，不会被再次编译。

## Trace 与结果

Host 日志中的 `dag.trace` / `dag.compiler.trace` 后为 JSON。

- 工具臂记录 `run-start`、`node-start`、`node-end`、`run-end`，用 `sessionId`、`runId`、`callId`、`subCallId` 关联调用。
- 编译器臂记录 `wave`、`task-end`、`plan-empty`、`compile-end`（含任务数、波数、最大波宽、重规划次数、调用数、三段耗时）、`compile-error`。

Trace 只记调度元数据，不记工具参数与内容（有测试断言）。工具参数与内容由 DSH 原有会话记录管理。

## 验证

```sh
npm run check      # build + 31 项测试 + pack dry-run
npm run benchmark  # 8 个 50ms 工具、四条两段分支，串行 vs 并发 4

# 与参考实现对拍（不 vendor 参考代码，按路径传入）
node scripts/parity.mjs /path/to/notes/src/bench-parallelqa-dag/dsh-demo/engine.mjs
```

`scripts/parity.mjs` 把参考实现自己的导出函数与本移植并排跑同一批输入并逐项断言深相等：`parseArgs`（23 例，含未闭合引号/方括号、裸标识符、数字、嵌套数组）、`dependenciesOf`（7 例）、`substitute` / `stringifyArgs`（7 例）、`parsePlan`（7 例）、`scheduleWaves`（7 例）、`parseJoinerOutput`（11 例），以及三段 prompt 的字节相等。当前结果 **72/72 identical**（两个分支相同：引擎代码在本分支除派发适配外未改动）。

当前结果：`npm test` 31/31 通过；benchmark 串行约 488 ms、`maxConcurrency=4` 约 118 ms。测试直接加载已发布 DSH 的 ToolRuntime，覆盖依赖引用、滚动调度、独占屏障、并发上限、权限拒绝、审批渠道缺失、作用域限制、上下文传递、回合结束、递归防护、取消收敛、卸载、trace；编译器侧覆盖 prompt 哈希、解析/调度/替换/joiner 单元、以及一次走真实工具注册表的端到端编译（含重规划与空计划）。

真实任务的收益仍需比较原生 DSH 基线，测量任务成功率、端到端耗时、模型轮数、token 用量及工具耗时。原生 DSH 已能并行执行同一轮中的安全工具，编译器臂的潜在增量来自预先表达跨轮依赖与减少模型决策往返。

## 设计参考与许可

- 参考实现：[bench-parallelqa-dag](https://gitcode.com/liuyang1271/notes/blob/master/src/bench-parallelqa-dag/README.md)（dsh 0.2.1-alpha.2 上的 LLMCompiler 零路由集成），及其验证文档与 [AISBench 结论](https://gitcode.com/liuyang1271/notes/blob/master/src/bench-aisbench-swebench-dag/README.md)。
- 上游：[LLMCompiler](https://github.com/SqueezeAILab/LLMCompiler) · arXiv:2312.04511。

MIT License。
