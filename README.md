# DSH DAG 插件

面向 **DeepSeek Harness `0.2.0-rc.2`** 的工具依赖图执行插件。包名为 `@sasimoreyang-ai/dsh-dag`，首版 `0.1.0-rc.1`。

模型调用 `dag_execute` 提交节点、工具参数和依赖关系。插件在依赖满足后调度节点，独立且声明并发安全的工具可以同时执行。原生 Agent 负责规划、理解结果与后续决策。

## 安装

需要 Node.js 22+、npm 和 DSH `0.2.0-rc.2`。所有 DSH peer dependency 均锁定此版本。

在要运行 DSH 的机器上，从源码构建安装包，再安装到目标 profile。以下命令适用于 Bash 和 PowerShell，`web` 为浏览器 profile。

```sh
git clone https://github.com/sasimoreyang-ai/dsh-dag.git
cd dsh-dag
npm ci
npm test
npm pack
dsh plugin --profile web add ./sasimoreyang-ai-dsh-dag-0.1.0-rc.1.tgz
dsh --profile web --dump-config
```

合成配置中应出现 `id: tool-dag` 以及 `name: '@sasimoreyang-ai/dsh-dag'`。启动 `dsh web`，已有进程需重启或等待配置热重载。使用自定义 `DSH_HOME` 时，安装与启动应使用同一个值。

本项目通过 `dsh.bundle.patch` 注册插件，工具通过 Cordis 的 `tools` 服务挂载。GitHub 源码需要先编译并打包，npm registry 的包名安装待 npm 发布后可用。

## 使用

向 Agent 提出适合分解的任务，例如“请用 dag_execute 并行读取 README.md 和 package.json，再汇总项目用途与启动方法”。模型需要能看到 `dag_execute` 和计划调用的工具。

下面是 `dag_execute` 的工具参数示例，使用 DSH 的 `read` 工具。

```json
{
  "nodes": [
    {
      "id": "readme",
      "tool": "read",
      "arguments": { "file_path": "README.md", "limit": 80 }
    },
    {
      "id": "package",
      "tool": "read",
      "arguments": { "file_path": "package.json", "limit": 80 }
    }
  ],
  "failurePolicy": "continue"
}
```

每个节点包含 `id`、`tool`、`arguments`，可选 `dependsOn`。节点 ID 允许 1–64 个英文字母、数字、下划线和连字符。工具名必须已注册且对当前 Agent 可见。参数有明确先后关系时应通过 `dependsOn` 表达，尤其是写入、读取同一文件等操作。

### 引用上游结果

在参数的任意位置使用 `{"$dagRef":{"node":"上游ID","pointer":"/字段路径"}}`。引用整个值时 `pointer` 使用空字符串。JSON Pointer 支持 `~0` 表示 `~`、`~1` 表示 `/`。

例如先执行下面的节点，再读取该节点返回的规范路径。这里 `read` 的 canonical result 包含 `path` 字段。

```json
{
  "nodes": [
    {
      "id": "head",
      "tool": "read",
      "arguments": { "file_path": "README.md", "limit": 10 }
    },
    {
      "id": "tail",
      "tool": "read",
      "dependsOn": ["head"],
      "arguments": {
        "file_path": { "$dagRef": { "node": "head", "pointer": "/path" } },
        "offset": 11,
        "limit": 10
      }
    }
  ]
}
```

每个引用的节点必须列入 `dependsOn`。引用使用工具经 DSH 执行管线处理后的 canonical value，具体字段由该工具的输出契约决定。动态字段不存在或参数类型不匹配时，该节点失败，其后继节点阻塞。`$dagRef` 为保留字段。

### 调度、权限和失败

- 全图先校验节点、依赖、环、工具可见性及无引用节点的参数。校验失败时返回工具错误。
- 依赖完成即可调度后继节点。并发数由 `maxConcurrency` 限制。
- 只有 DSH 判定为 `parallel` 的调用能够重叠。其他调用独占执行，并形成调度屏障。图外仍由 DSH 的原生调度器管理。
- 每个节点通过 `ctx.tools.execute` 调用，继承原 Agent、根调用 ID、父执行 token 和取消信号，经过原生权限、审批、沙箱与结果策略。
- `continue` 为默认失败策略，继续执行独立分支。`stop` 在失败后停止派发排队节点，等待在途调用结束。
- 节点状态包括 `succeeded`、`failed`、`blocked`、`cancelled` 和 `skipped`。检查节点状态后再决定下一轮计划。已成功的写入会保留，重试需要结合返回状态判断。
- 超时、用户取消和插件卸载会取消正在运行的调用，并等待它们完成清理。工具需要遵守 DSH 的取消契约，忽略信号的工具会延迟收敛。
- 子工具的附加上下文和 `concludesTurn` 会传递给原生 Agent。结束回合后停止派发剩余节点。
- 直接及经其他工具间接递归调用 DAG 均被拒绝。

## 配置

在目标 profile 的 `cordis.patch.yml` 中追加覆盖条目。

```yaml
- id: tool-dag
  config:
    maxConcurrency: 4
    maxNodes: 32
    timeoutMs: 120000
    maxInputChars: 200000
    maxNodeOutputChars: 8000
    trace: true
```

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `maxConcurrency` | 4 | 每次 DAG 执行最多 1–16 个在途节点 |
| `maxNodes` | 32 | 单次图节点上限，允许 1–128 |
| `timeoutMs` | 120000 | 图执行总期限，包含审批等待，允许 1–3600000 毫秒 |
| `maxInputChars` | 200000 | 输入节点数组序列化后的字符上限 |
| `maxNodeOutputChars` | 8000 | 每个节点返回投影的字符上限，截断时标记 `truncated` |
| `trace` | true | 向 DSH host 日志输出结构化调度记录 |

输出截断作用于返回给模型的节点投影。依赖取值在本次执行内使用完整 canonical value。大量工具输出仍会占用内存，应结合 DSH 的工具输出限制控制单次工作量。

## Trace 与结果

Host 日志中的 `dag.trace` 后为 JSON，包含 `run-start`、`node-start`、`node-end`、`run-end`。使用 `sessionId`、`runId`、`rootCallId`、`callId`、`subCallId` 关联调用，可查看节点状态与耗时。`node-start` 表示进入工具执行管线，最终权限判断及执行结果以 `node-end` 为准。阻塞或跳过节点仅有结束记录。

Trace 记录调度元数据。工具参数与内容由 DSH 原有会话记录管理。`dag_execute` 的正常结果包含完整节点状态表、耗时和经过工具结果策略的内容投影，可在原生工具结果及会话导出中查看。用户取消时 DSH 可能将外层结果替换为取消错误，已发生节点的状态可在 host trace 中核对。

容器部署时，在对应 DSH 容器日志中筛选 `dag.trace`。终端启动时保存 host 标准输出和标准错误。此版本使用通用工具卡片展示结果。

## 验证

```sh
npm run check
npm run benchmark
```

测试直接加载 npm 发布的 DSH `0.2.0-rc.2` ToolRuntime，覆盖依赖引用、滚动调度、独占屏障、并发上限、权限拒绝、审批渠道缺失、作用域限制、上下文传递、回合结束、递归防护、取消收敛、卸载和 trace。

安装链路检查需要本地已安装的 DSH CLI 入口路径。脚本会建立独立临时 `DSH_HOME`，打包、安装、检查 Web profile 的 bundle 选择及配置合成，然后以单独插件组合检查配置 schema 导入，并输出该临时目录以便检查。

```sh
npm run check:install -- /absolute/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js
```

基准包含四条双节点分支，每个合成工具等待 50 毫秒，比较 `maxConcurrency=1` 与 `4`。它验证调度重叠能力。真实任务的收益还需要比较原生 DSH 基线，测量任务成功率、端到端耗时、模型轮数、token 用量及工具耗时。原生 DSH 已能并行执行同一轮中的安全工具，DAG 的潜在增量主要来自预先表达跨轮依赖和减少模型决策往返。

首版仍需要实际模型任务的端到端效果评测。模型是否调用 DAG、图规划质量、依赖宽度及工具安全声明都会影响收益。插件可与 AgentHint 同时安装，组合加速效果需单独测量。

## 编译式编排内核

`src/compiler` 提供一个与挂载点无关的编译器内核：把任务一次性编译成依赖图，按轮执行并交由评审决定收敛，而不是让模型逐轮决定下一步。它**不替代** `dag_execute`，两者共用同一执行器。

| 模块 | 职责 |
| --- | --- |
| `compiler/plan.ts` | 计划文本解析：编号行、`$n` / `${n}` 依赖、`join()` 哨兵、缺编号兜底、只接受字面量参数（不求值、不插值） |
| `compiler/prompts.ts` | planner / joiner 提示词构造与 joiner 决策解析（`Finish(...)` / `Replan(...)`） |
| `compiler/engine.ts` | 轮循环：计划 → 执行 → 评审 → 重规划；含轮数上限、token 预算、连续空计划熔断、旧轮次上下文压缩、净变更门禁钩子 |

执行、规划、评审都通过回调注入，因此同一内核可用于工具挂载、`llm/stream` 短路或测试替身：

```js
import { compile, positionalNodes } from '@sasimoreyang-ai/dsh-dag/compiler'

const result = await compile(
  { question, knownTools, plannerTools, tokenBudget: 120000 },
  { plan, join, execute, toNodes: positionalNodes('command'), workingTreeChanged },
)
```

**验证**：`npm test` 跑全部用例（含编译器 13 条）；`npm run smoke` 用桩回调跑两个场景——
「重规划一次后收敛」与「净变更门禁拒绝首次 Finish」——不依赖模型或 DSH 运行时，输出每轮决策与状态计数。

**当前边界**：本版本只交付内核与单元测试（解析、决策、轮循环、预算与门禁路径）。与 `llm/stream` 或 `ctx.llm` 的真实接线、以及真实模型任务的端到端评测尚未包含；内核的正确性由 `tests/compiler.test.mjs` 覆盖，不依赖模型。

## 设计参考与许可

参考了 LLMCompiler 的依赖调度思路，以及提供的 AISBench/DSH DAG 实验资料。本仓库独立实现 TypeScript 调度与 DSH 适配。资料中提及的本地 DSH 原型源码没有随 notes 仓库公开，本实现依据可获取的文档和 DSH 已发布接口开发。[LLMCompiler](https://github.com/SqueezeAILab/LLMCompiler) · [实验资料](https://gitcode.com/liuyang1271/notes/blob/master/src/bench-aisbench-swebench-dag/README.md)

MIT License。
