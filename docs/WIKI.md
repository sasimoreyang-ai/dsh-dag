# DSH DAG 插件 Wiki

> **一句话**：这是一个 DeepSeek Harness（DSH）插件，把 agent 的「边想边做」改成「先规划、再并行执行、最后总结」。它不改 DSH 一行源码，像耳机插进公开插孔一样工作。

本页面向三类读者：想理解原理的工程师、想装上试试的使用者、以及后续维护者。前半部分用类比讲原理，后半部分是严谨的实现与验证细节。

---

## 1. 为什么要有它：Agent Loop 的三笔隐性开销

DSH 原生的 agent loop 是「边想边做」：每做一步都要过一遍模型，把全部历史重新发给它。拿一个典型问题举例（两条海沟各变化 20%，哪条更浅？）：

```text
想 ──► 调 search(海沟A) ──► 看结果 ──► 想 ──► 调 search(海沟B) ──► 看结果 ──► 想 ──► 调 math ──► 答案
     模型往返 1 次          模型往返 2 次              模型往返 3 次              模型往返 4 次
```

这里有三笔隐性开销：

| 开销 | 说明 |
| --- | --- |
| **逐步决策** | 每一步之间都要过一遍模型，而模型是一切里最慢的环节 |
| **串行空转** | `search(A)` 和 `search(B)` 明明互不依赖，loop 只能一个一个来 |
| **上下文重发** | 每一步都把完整对话历史重新发一遍，越到后面每步越贵 |

实测（113 题，同模型同工具同题目）：原生 loop 平均每题 6.33 次模型调用、7.2 秒。

---

## 2. DAG 的原理：让模型先交施工图

DAG（有向无环图）把「边想边做」改成三阶段。类比：不是让工人边想边砌墙，而是先让工程师出一张标明了工序依赖的施工图，然后多个工人按图并行开工。

```text
┌─ 阶段一：Planner（1 次模型调用）─────────────────────────┐
│  模型把问题"编译"成一份带依赖声明的计划：                    │
│    1. search("Mariana Trench")                            │
│    2. search("Puerto Rico Trench")                        │
│    3. math(深度差, 用 $1 和 $2 的结果)                      │
│    4. join()                    ← 收尾动作                 │
│  $1、$2 是占位符："把第 1、2 步的结果喂给我"。               │
│  依赖关系就声明在这一行里。                                  │
└──────────────────────────────────────────────────────────┘
┌─ 阶段二：调度 + 并发执行（0 次模型调用）───────────────────┐
│  看依赖图分波：                                            │
│    波 1：search(A) ∥ search(B)     ← 互不依赖，同时发       │
│    波 2：math(用 $1、$2)           ← 等波 1 的结果          │
│  结果直接替换进 $id 占位符。                                 │
└──────────────────────────────────────────────────────────┘
┌─ 阶段三：Joiner（1 次模型调用）───────────────────────────┐
│  把全部观测拼给模型，输出最终答案；                          │
│  若它认为不行，可输出 Replan 回到阶段一重新规划。             │
└──────────────────────────────────────────────────────────┘
```

效果：**4 个工具调用只需要 2 次模型调用**（planner + joiner），而且第一波的两个检索是并行跑的。

### 收益从哪来？三个来源，大小差别很大

1. **真并发**：互不依赖的工具同时跑（实测 execute 段内任务串行总时长 / 墙钟 = 2.12×）
2. **少过模型**：调用次数从 6.33 次/题 降到 6.24 次/题，但**决策往返**从多步收敛为 2 次
3. **上下文不重发**：DAG 每次只发「问题 + 计划/观测」，实测 prompt token 只有 native 的 1/11

### 但收益有前提：任务形态决定胜负

这是整套方案最重要的一个判断，也是最容易踩的坑：

| 任务形态 | 例子 | DAG 的表现 |
| --- | --- | --- |
| **多波依赖**（一批独立调用 + 依赖计算） | ParallelQA 问答：2–5 路检索 → 汇总计算 | **真实收益**：比原生快 1.30×，比关闭并发的 loop 快 1.66× |
| **单层 DAG**（只有一拨独立调用） | 简单检索问答 | **反而更慢**（4.36s vs 7.59s）：原生 loop 本来就会把同一条消息里的多个工具调用并行发出去，DAG 白付 planner/joiner 两次调用 |
| **窄而深的探索**（每步依赖上一步） | SWE 编码任务：读文件 → 改 → 验证 | **更慢且正确率更低**：并发无从发挥，planner 的静态计划还容易被中途观测推翻 |

一句话：**DAG 的收益 ∝ 任务的依赖宽度 × 波数，成本（两次额外模型调用 + 计划脆弱性）是固定的**。任务里能并行的部分越多越赚；每步都依赖上一步的任务，用原生 loop。

---

## 3. 插件在 DSH 上怎么工作：一个公开的「事件缝」

**核心结论：DSH 本体一行源码都没改。** 插件与 DSH 的全部接触面只有公开的 `llm/stream` 事件和工具注册表。

### 3.1 拦截点：`llm/stream` waterfall

DSH 每一次模型调用都会流经一个公开的拦截点。插件在这里挂监听器，对每个请求做一个判断：

```text
外层 agent loop
   │  "这次要调模型了"
   ▼
┌────────────── llm/stream（公开事件缝）──────────────────────┐
│  这是外层 loop 自己的调用吗？                                 │
│  ├─ 不是（其它插件、工具内部的调用）→ 原样放行 next()           │
│  └─ 是 → 接管：整个模型流替换成三阶段 DAG                      │
└──────────────────────────────────────────────────────────┘
```

被接管的那一轮：**外层零次真实模型调用**。loop 只看到一条合成的 assistant 消息（joiner 的答案）。而对 DSH 来说，session 日志、回合生命周期、权限审批、工具执行管线——全部还是它自己的原生机制在跑。

**怎么判断「是外层 loop 的调用」？** 两种判据（可配置）：

- `marker`：DSH 会在 loop 自己构造的请求上打官方标记（`isAgentLoopRequest`），最精确
- `heuristic`：参考实现用的结构特征（请求不带 `system` 字段、首条消息是 system 角色、含用户消息）

### 3.2 两条臂，各自可开关

| 臂 | 是什么 | 默认状态 |
| --- | --- | --- |
| **`dag_execute`（工具臂）** | 给模型多一个工具：模型自己决定何时提交一张任务图（节点 + 依赖边），插件负责校验、调度、并发执行 | 装上即启用 |
| **`dag-compiler`（编译器臂）** | 上面讲的「接管整轮」模式，即 LLMCompiler 语义 | **默认关闭**——它会替换每一轮的模型调用，且需要配置模型路由 |

两条臂可以同时安装、互不干扰：工具臂是模型主动调用，编译器臂是接管外层调用。

### 3.3 生命周期

插件跟随 Cordis 的标准生命周期：卸载时先取消所有在跑的编译（AbortSignal），再等它们排空（`allSettled`），不会留下半截任务。编译过程中工具再触发模型调用，不会被递归接管。

---

## 4. 安装与启用

需要 Node.js 22+（推荐 24，CLI 依赖 `import.meta.main`）和对应版本的 DSH。

```sh
git clone https://github.com/sasimoreyang-ai/dsh-dag.git
cd dsh-dag && git checkout main
npm ci && npm test && npm pack
dsh plugin --profile <profile> add ./sasimoreyang-ai-dsh-dag-<version>.tgz
dsh --profile <profile> --dump-config     # 应看到 tool-dag 与 dag-compiler(disabled)
```

启用编译器臂：在 profile 的 `cordis.patch.yml` 里加一段（也可以用 `--patch` overlay 临时试）：

```yaml
- id: dag-compiler
  disabled: false
  config:
    provider: <你的 provider 路由>
    model: <模型 id>
    detect: marker            # 生产建议 marker；heuristic 用于复现参考实现
    emptyAnswer: diagnostic   # 编译无答案时给出诊断而不是空消息
    metricsPath: /path/engine.jsonl   # 可选：逐轮落一条引擎记录，用于验证
```

**验证它真的在工作**：配 `metricsPath` 后每轮会追加一条 JSONL 记录（planner/joiner 耗时、任务数、波数、searchCalls/mathCalls 计数、replans、answer）。

> ⚠️ **thinking 模型必读**：如果模型默认带思考（如 DeepSeek 混合推理模型），planner/joiner 可能把 token 预算花在思考上、返回空 content。请显式配 `reasoningEffort: 'off'`，或调大 `maxTokens`。

---

## 5. 与参考实现的关系

本插件的引擎是 [liuyang 的 ParallelQA 参考](https://gitcode.com/liuyang1271/notes/blob/master/src/bench-parallelqa-dag/README.md)（其本身是 [LLMCompiler 论文](https://arxiv.org/abs/2312.04511) 的移植）的 TypeScript 重写，忠实度用**差分对拍**验证，不是"看着像"：

| 验证层 | 方法 | 结果 |
| --- | --- | --- |
| 引擎控制流（`runCompiler`） | 参考实现与本插件并排跑 13 个场景，逐项比较每次模型调用的 payload、每次工具派发的 callId/参数/顺序、metrics 全键、抛错文本 | **13/13 全同** |
| 纯函数 + prompt | `parseArgs` / 依赖推断 / 计划解析 / 替换 / 波次调度 / joiner 解析 + 三段 prompt | **72/72 identical**（prompt 为 sha256 逐字节） |
| 接缝判据 | `isLoopRequest` / `questionOf` 逐用例对照（9 组边界） | **9/9 等价** |
| 真宿主无头链路 | 真 `dsh --profile headless` + 桩模型，断言完整链路 | **9/9 PASSED** |

**有意保留的增强**（参考实现没有，均已在下文注释）：递归防护、取消融合与卸载排空、agent 归属解析、空答案诊断、可配置工具词汇。所有差异可在 `README.md` 的差异表中逐条核对。

---

## 6. 已知边界（读这部分能省掉最多排查时间）

1. **任务形态不合适就是负收益**——回到 §2 的表格判断。编码类探索任务不建议上编译器臂。
2. **thinking 模型返回空 content** → 走「无答案」路径。配 `reasoningEffort: 'off'`。
3. **无答案不会静默**：`emptyAnswer: diagnostic`（默认）输出诊断文本；`error` 以 `DAG_COMPILER_EMPTY_ANSWER` 失败。
4. **观测默认不截断**（忠实参考实现）：挂返回大输出的工具时，建议显式设 `maxToolOutputChars`，否则整个观测会原样进 joiner 的 prompt。
5. **计划解析器照搬 Python `literal_eval` 语义**：计划里写 Windows 路径要用正斜杠，单反斜杠会被当转义吃掉。
6. **host logger 不一定落 stderr**：验证拦截是否发生，用 `metricsPath`，别依赖日志。
7. **编译器臂会接管每一次 loop 模型调用**：没有逐轮白名单；`detect` 与 `tools` 是唯一的收窄手段。生产 profile 建议 `detect: marker`。

---

## 7. 术语表

| 术语 | 含义 |
| --- | --- |
| **Agent Loop** | 原生模式：模型每步临场决定下一个动作，依赖对话历史 |
| **DAG** | 有向无环图；这里指把任务编译成带依赖的执行图 |
| **Planner** | 阶段一：把问题编译成编号计划（1 次模型调用） |
| **Task Fetching Unit** | 阶段二：贪心派发所有「依赖已满足」的任务，替换 `$id` 占位符 |
| **Joiner** | 阶段三：汇总观测，输出 `Finish(answer)` 或 `Replan(reason)`（1 次模型调用） |
| **波（wave）** | 一批依赖已满足、可同时执行的任务 |
| **`$id`** | 计划里的占位符，引用第 id 步的输出 |
| **Replan** | joiner 判定计划不行，带着观测重新规划 |
| **编译器臂 / 工具臂** | 接管整轮（LLMCompiler 语义）vs 模型主动提交任务图两种模式 |
| **非侵入** | 只挂公开事件缝与注册表，DSH 源码零修改 |

## 8. 参考资料

- 参考实现：[bench-parallelqa-dag](https://gitcode.com/liuyang1271/notes/blob/master/src/bench-parallelqa-dag/README.md)（dsh 0.2.1-alpha.2 上的零路由集成）
- 参考实现的验证汇总：[DSH 优化验证汇总](https://gitcode.com/liuyang1271/notes/blob/master/src/bench-parallelqa-dag/README.md)（113 题四臂对比、SWE 方向结论）
- 论文：[An LLM Compiler for Parallel Function Calling](https://arxiv.org/abs/2312.04511)（ICML 2024）
- 仓库：[sasimoreyang-ai/dsh-dag](https://github.com/sasimoreyang-ai/dsh-dag)

MIT License。
