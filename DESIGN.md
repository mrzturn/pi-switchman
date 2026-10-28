# pi-switchman 设计文档

> 状态：v1.1 草案（新增：[F] TUI 配置中心、双决策器路由、本地决策模型接入），待评审
> 前身：[dsh-switchman](https://github.com/mrzturn/dsh-switchman)（DeepSeek Harness 版）。
> 本文档不是移植方案——是借 dsh-switchman 的调度理念，用 pi 的原生原语重新设计。

---

## 1. 定位

**一句话**：pi 的上下文经济学引擎——管住每一个进入上下文的 token（入口压缩），把工作派到成本最低的执行层（分层执行矩阵），让模型选择只在一个入口发生（sticky 虚拟模型路由）。

**核心理念转变**（相对 dsh-switchman）：

| | dsh-switchman | pi-switchman |
|---|---|---|
| 组织原则 | 调度器 + 水表（**出口管控**：满了再治） | 上下文经济学（**入口管控**：垃圾不让进 + 分层执行） |
| 模型选择 | 设置页六池 GUI + 白名单同步 + 推荐表注入 | 一个 virtual model，路由即配置 |
| 长会话治理 | fork 备份 + 压缩 + 唤醒交接（事故高发区） | 委托 pi 原生 compaction + 定制摘要，交接机制蒸发 |
| 读预算 | 拒绝/截断读取（模型变瞎） | 入口压缩（模型看得见全景，细节按需取） |
| 便宜活派发 | 派给便宜模型（子 LLM） | 能派给代码就派给代码（Tier 0/1，零 LLM 成本），"派发"从常态变例外 |

## 2. 与 dsh-switchman 的能力对照

| dsh 能力 | pi 版命运 | 理由 |
|---|---|---|
| 水位三档（80k/120k/150k） | **降级为仪表盘 + 保险丝** | 大部分工作被入口压缩和分层执行在上游完成 |
| 六池派发 + GUI | **变形**：泳道×有序模型表（TUI 可配，§4.6）+ agents/*.md + virtual model 路由 | 单一事实源，无第二套状态 |
| 分级验证 | **保留** | 独立性 = 隔离上下文，天然适合 Tier 2/3 |
| 意图识别路由 | **变形并强化**：双决策器（本地决策模型 + 内置规则打底）+ 泳道粘滞，TUI 可配 | 决策端点协议 pi 原生支持；缓存语义平台已管 |
| 交接机制 | **蒸发** | `session_before_compact` 定制摘要 + appendEntry 台账 |
| Agent Teams | **砍** | 子进程 subagent + 并行已覆盖，pi 无任务板原语 |
| 设置页 GUI / 多语言 / /vision | **部分回归**：路由配置以精简 TUI 中心承载（§4.6）；DSH 式全量设置页、多语言、/vision 仍砍 | pi 是配置文件文化；图片原生支持（`input` 字段判多模态） |
| 读预算双闸 | **降级**为压缩管线的兜底档 | 见 §4.1 |
| capability-default.json（179 模型快照） | **缩到极小或为零** | pi 目录自带价格/effort/窗口/模态，快照只需档位提示（§4.4） |

## 3. 总体架构

```
                       ┌────────────────────────────────────────────┐
                       │              pi 主进程（扩展运行时）          │
                       │                                            │
  用户/模型 ──tool结果──▶│  [A] 入口压缩管线 (tool_result 钩子)          │
                       │      └─ 大结果→临时文件+蒸馏文本；expand 工具   │
                       │                                            │
                       │  [B] 执行矩阵 dispatch 工具                   │
                       │      ├─ Tier 0 gather: 内嵌 executeTool 编排  │
                       │      ├─ Tier 1 codemode: 脚本批量(可选启用)    │
                       │      ├─ Tier 2 judge: streamSimple 单发判断    │
                       │      └─ Tier 3 run: 子进程 subagent(多轮隔离)  │
                       │                                            │
                       │  [C] switchman/auto 虚拟模型 (双决策器 sticky 路由)│──▶ 物理模型
                       │      └─ [D] 能力知识层: 活目录+锚点+推断+规则打底 │
                       │                                            │
                       │  [E] 水位仪表盘+保险丝 (getContextUsage)       │
                       │      └─ force → pi 原生 compaction + 定制摘要  │
                       │                                            │
                       │  [F] TUI 配置中心 (/switchman:config)          │
                       │      泳道×有序模型表 / 决策模型 / 换留阈值      │
                       └────────────────────────────────────────────┘
```

数据流关键点：

- **A 在 transcript 入栈前拦截**——未压缩版本从未污染缓存前缀，零缓存代价。
- **B 的 Tier 0/2 不产生任何 transcript 条目**（嵌套调用原生如此）；Tier 3 是独立子进程，只有蒸馏报告回流。
- **C 是模型选择的唯一入口**：`/model` 选 `switchman/auto`，之后一切自动；手动 `/model` 直选物理模型也照常工作（路由即旁路）。
- **E 只做观测和兜底**，不做主治理。

## 4. 组件设计

### 4.1 [A] 入口压缩管线

**挂载点**：`pi.on("tool_result", ...)`（chained transformation，可替换 `content`；声明了 `outputSchema` 的工具须同步替换 `structuredContent`）。

**策略**（启发式优先，确定性、零延迟、零 LLM 成本）：

1. 阈值判定：文本结果 > `compress.threshold`（默认 8000 字符）才动；以下免检：
   - `isError` 结果（错误信息直接放行，诊断价值高）
   - 嵌套调用（`parentToolCallId` 存在）——本就不进 transcript
   - bash 结果——pi 已截断到 2000 行/50KB 且带 `full_output_path`，只压仍超限的
2. 蒸馏形态（按工具定制）：
   - `read`：头 N 行 + 尾 M 行 + 中间折叠行数标注 + "用 expand 取中段"
   - `grep`：命中计数 + 去重后的文件路径清单 + 每文件命中数
   - `glob`：计数 + 目录级折叠
   - 其他/未知：头尾保留 + 折叠标注
3. 原文去向：写进程级临时文件（模式对齐 bash 的 `full_output_path`），路径写进蒸馏文本尾注。**不改已持久化的 entry**——只改本次进入 transcript 的 `content`。
4. `expand` 工具：`{ path, offset?, limit? }` 分段取原文。这就是"模型索要原文的正门"，引导协议里写明。

**分级**：水位 hard 档时阈值收紧到 40%（§4.5），soft/正常档用全值。

**明确不做**：小模型摘要压缩（后期可选，仅超大结果且用户显式开启）；对图像 content 的处理。

### 4.2 [B] 执行矩阵 dispatch 工具

单工具多模式（对齐官方 subagent 示例的 agent/parallel/chain 三模式风格）：

```typescript
dispatch({
  mode: "gather",            // Tier 0：定向收集，过程全弃
  description,               // 供台账与渲染
  steps: [{ tool: "grep", args: {...} }, ...]   // 顺序/并行执行
})
dispatch({
  mode: "judge",             // Tier 2：单发判断（复审/分类/起标题）
  task, lane?: "review" | ...,   // lane 触发能力层选模型
  prompt?, model?            // 可显式点名（enforce 闸挂载点）
})
dispatch({
  mode: "run",               // Tier 3：隔离多轮 subagent
  agent, task,               // agents/*.md 定义
  model?, thinking?          // 不钉则继承主会话（派发时刻快照）
})
// 并行/链式：tasks: [...] / chain: [...]（对齐官方示例）
```

- **Tier 0 实现**：工具 `execute()` 内部循环 `ctx.executeTool(name, args)`——真实走参数校验和 tool_call/tool_result 钩子，但**不产生 transcript 条目**；工具自己返回蒸馏汇总（每步一行状态 + 结果要点）。子调用结果计入本工具的 usage 报告。
- **Tier 2 实现**：`ctx.modelRegistry.streamSimple(model, context)` 单发；结果 + usage 一条 tool result 装下。复审（review lane）默认锚定"产出 diff 的模型"避同源（沿用 dsh 语义：锚不到则声明 DOWNGRADED）。
- **Tier 3 实现**：spawn `pi --mode json -p --no-session --model <physical> [--thinking] [--tools] --append-system-prompt <tmp>`（照官方示例：临时文件传系统提示、流式进度、abort 传播、退出码/stopReason 错误处理）。结果回流封顶 50KB/任务，完整报告落临时文件供 expand。
- **virtual→physical 解析**（第一个正确性问题）：`ctx.model` 报的是虚拟 id（如 `switchman/auto`），子进程不认识。派发时解析为**最近一次 assistant 消息记录的物理模型**；无历史则回退路由函数当前决策。
- **enforce 闸**：`model` 显式点名时校验是否在配置的池内；池外 deny 并给出推荐路由（挂在本工具内，不动系统级白名单——pi 无此白名单，也不需要）。
- **台账（ledger）**：每次 dispatch 后 `pi.appendEntry("switchman:ledger", { id, mode, description, status, reportPath })`——不进上下文、随分支、可从 `getBranch()` 重建。Tier 3 在跑期间台账 status=running，这是防重复派发的依据（dsh 版 double-dispatch 事故的 pi 原生解）。

### 4.3 [C] switchman/auto 虚拟模型（双决策器 + 泳道粘滞路由）

```typescript
pi.registerVirtualModel({
  provider: "switchman",
  id: "auto",
  thinkingLevels: ["low", "medium", "high"],
  contextWindow: <取候选集最小窗口或省略>,
  route(request, ctx) { ... }
})
```

**泳道有序模型表是路由的第一输入**（TUI 配置中心 §4.6 编辑，存 switchman.json；`null`/缺省 = 能力层自动排序，§4.4）：

```
lanes = {
  hard:    [有序模型列表],   // 高难推理/大规模重构
  main:    [有序模型列表],   // 日常编码
  economy: [有序模型列表],   // 轻量批量
  review:  [有序模型列表],   // 独立复审
  vision:  [有序模型列表],   // 多模态（可选）
}
```

**路由决策顺序**（每请求前跑）：

```
1. 粘滞优先（平台语义，无条件）：
   - reason=continuation → previous（保缓存）
   - reason=retry → failed.model（保思考签名）
   - reason=direct（compaction 摘要等）→ economy 头名
2. reason=user 边界 → 泳道判定（双决策器，主备切换）：
   决策器 = 决策模型可用 ? classifier 决策 : 内置决策打底
   a. classifier 决策（用户配置的决策模型，如本地 Ollama tev1 的
      systemone 端点，接入方式见 §6）：
      classify(state={ prompt摘要, 当前物理模型, 各泳道候选 },
               questions={ lane: choice(...), complexity: score })
      → (lane, confidence)
      不可用判定：未配置/目录中不存在/超时(decisionTimeoutMs，默认 2s，
      AbortSignal)/stopReason≠stop —— classify() 平台保证 never-rejects
   b. 内置决策打底（零 LLM、零延迟、零成本的规则链，常驻兜底）：
      - 消息含图 → vision
      - thinkingLevel=high / 长任务描述 / 含重构·架构·疑难调试信号 → hard
      - 短问答 / 单点小改 → economy
      - 默认 → main
3. 换/留判定（缓存窗口 + 置信度双闸，对齐 dsh 版意图识别语义）：
   判定泳道后，当前物理模型 ∈ 该泳道有序列表？
   - ∈ 且（confidence < switchConfidence 或 距上次切换 < cacheWindowMs）
     → 留（缓存续用）
   - ∉，或（confidence ≥ 阈值 且 窗口外）
     → 换到该泳道列表中第一个「此刻可用」的模型
     （列表头名凭据失效 → 顺位下移；可用性 = getAvailable() 现查）
4. 任何失败路径 → 留在 previous；无 previous → main 头名；
   再不行 → 目录第一个可用。fail-open。
```

**router state**（JSON，存会话分支、穿越 compaction）只放轻量数据：`{ lane, lastPhysical, lastSwitchTs, decision: { ts, by: "classifier" | "builtin", confidence } }`。**台账不放这里**（会膨胀且不可控），放 appendEntry。

**决策模型调用门**：只在 `reason: "user"` 边界 + 距上次成功决策超过 `decisionIntervalMs`（默认 60s，防连续追问反复打决策端点）。决策模型不在场时整套路由完全自治（内置打底即决策器），这正是"决策模型可用则参与、不可用自有打底"的语义。

### 4.4 [D] 能力知识层

**候选集**：每次决策现查 `ctx.modelRegistry.getAvailable()`（凭据完整的模型）——换 provider、删凭据、目录刷新，下一请求自动生效。**不存模型清单。**

**档位判定**（S/A/B/C → 映射到 hard/main/economy 泳道）：

```
score(model) =
  ① 锚点配置（用户钉的 provider/model → 档位，永远最优先）
  ② 精选快照（可选、极小：只存档位提示，不存存在性/价格/effort——目录都有）
  ③ 推断（纯函数，对未见模型生效）：
       名字启发式：flash|mini|haiku|air|lite → 轻；opus|ultra|max|pro → 重
       价格代理：cost.input/output 作能力粗排序（同族内强相关）
       佐证：reasoning、contextWindow、input 含 image → 多模态池
     键折叠：normalizeModelKey（剥 provider 前缀/变体段）匹配已知族
  ④ classifier 仲裁（可选）：候选(id/价格/窗口)+任务 → choice
```

**回退链**：①→②→③ 按序取第一个命中；④ 只做平局仲裁。全空 → 目录顺序，永不抛错。

**与路由的双向关系**：本层另含一套「泳道判定规则链」（§4.3 的内置决策打底）——决策模型在场时它是备胎，不在场时它就是决策器。泳道未配置时，泳道内的模型排序也由本层 ③ 推断生成（锚点→快照→名字/价格启发式），TUI 配置的有序表则永远覆盖自动排序。

### 4.5 [E] 水位仪表盘 + 保险丝

**观测源**：`ctx.getContextUsage()`（原生上下文用量）。

| 档 | 阈值（可配，默认） | 动作 |
|---|---|---|
| ok | < 70% | 静默 |
| soft | ≥ 70% | 状态行提示；**首次进入档位**时尾部 custom message 引导"优先 gather/codemode 派发"（节流：只在档位跃迁时发，不逐轮刷屏） |
| hard | ≥ 85% | 压缩阈值收紧至 40%；状态行警示 |
| force | ≥ 95% | `ctx.compact()` 触发原生压缩（自动含溢出恢复重试），fire-and-forget |

**定制摘要**：`pi.on("session_before_compact")` 里把台账（getBranch 中的 ledger 条目）+ router state 相位合并注入 `compaction.details`，自定义摘要生成时带上"未决派发清单"——**交接文档的本质，但由 pi 原生 compaction 承载，零自建交接机械**。

**暂停**：`/switchman:pause`、`/switchman:resume`（会话级状态；重启后自动恢复执行，对齐 dsh 语义）。

### 4.6 [F] TUI 配置中心（/switchman:config）

**挂载点**：`pi.registerCommand("switchman:config")` → `ctx.ui.custom()` 全屏交互组件。组件基础用 `@earendil-works/pi-tui` 的 `SettingsList` / `SelectList`（官方为「可搜索选择 + 设置流」预制的组件；宿主提供包，扩展以 `peerDependencies: "*"` 声明即可 import，见 packages.md）。

**界面结构**（单屏三区，上下键导航）：

```
┌ Switchman 配置 ──────────────────────────────────┐
│ 泳道    模型（有序：↑↓ 调序 · × 移除 · a 添加）      │
│  hard    anthropic/claude-opus-4-5                │
│          openai-codex/gpt-5.6-sol                 │
│  main    …（凭据失效条目标灰，路由会自动顺位跳过）   │
│  economy …    review …    vision …                │
├──────────────────────────────────────────────────┤
│ 决策模型   ollama-local/tev1:4b-mxfp8   [选择…]    │
│   （候选 = 目录中 type=classifier 的模型，现查）    │
│ 置信度阈值 0.80 · 缓存窗口 300s · 决策间隔 60s      │
│ 内置打底   规则链（只读展示，说明其常驻兜底）        │
├──────────────────────────────────────────────────┤
│ 添加模型：SelectList 搜索（provider/model + 价格 + │
│ 窗口 + 档位提示），回车加入当前泳道尾部             │
└──────────────────────────────────────────────────┘
```

**要点**：

- **配置双通道**：TUI 只是 `switchman.json` 的编辑器——JSON 文件始终可手改，二者同源；保存 = 原子写文件，下一次 `route()` 现读即生效，无需重启。
- **候选现查**：泳道候选与决策模型列表都从 `modelRegistry` 现查（`getAvailable()` / `getModelsOfType("classifier")`），换 provider 后重开界面列表自动变——不存在陈旧清单。
- **模式守卫**：`ctx.mode === "tui"` 才走交互组件；RPC/JSON/print 模式下 `/switchman:config` 退化为打印配置文件路径 + 当前配置快照 + 决策器健康状态。
- **泳道语义与 TUI 一致**：界面里的顺序就是 §4.3 第 3 步的顺位依据。

## 5. 横切不变量（缓存宪法）

1. **前缀字节恒定**：`before_agent_start.systemPromptOptions.sections` 注入的引导协议段，对给定配置字节恒定（不随水位/时间变化）；活数字一律走尾部 custom message 通道。sections 是 keyed、独立可替换的——但我们的段从不中途改文本。
2. **工具声明稳定**：不用会触发 transcript checkpoint 的动态工具切换；闸门全部走 `tool_call` 阻断 / 工具内参数校验。
3. **模型粘滞**：换物理模型只发生在 `reason: "user"` 边界 + 高置信度，其余一律 `previous`/`failed`。
4. **单一事实源**：模型知识只住能力层；dispatch 选型、路由选型、enforce 校验共用同一打分函数。
5. **fail-open**：任何钩子崩溃降级为放行/默认档，绝不阻塞工具或抛进装配链。
6. **协议文本英文且字节稳定**（跨语言捕获与测试锚定，沿用 dsh 铁律；`[SWITCHMAN:...]` 锚点行）。

## 6. 配置面（无 GUI）

```
~/.pi/agent/switchman.json          # 全局
.pi/switchman.json                  # 项目级（覆盖合并）
~/.pi/agent/agents/*.md             # 用户级 agent 定义（Tier 3）
.pi/agents/*.md                     # 项目级（需项目信任，dispatch 时确认，照官方示例）
```

```jsonc
{
  "compress": { "threshold": 8000, "readHead": 60, "readTail": 20 },
  "watermark": { "soft": 0.70, "hard": 0.85, "force": 0.95 },
  "anchors": [ { "provider": "anthropic", "model": "claude-opus-4-5", "tier": "S" } ],
  "router": {
    "lanes": {                          // 有序模型表（TUI 编辑；null/缺省=能力层自动）
      "hard":    [ { "provider": "anthropic", "model": "claude-opus-4-5" } ],
      "main":    null,
      "economy": null,
      "review":  null,
      "vision":  null
    },
    "switchConfidence": 0.80,           // 换道置信度阈值
    "cacheWindowMs": 300000,            // 缓存窗口：窗口内优先沿用当前模型
    "decisionIntervalMs": 60000,        // 决策端点最小调用间隔
    "decisionTimeoutMs": 2000,          // 决策端点超时
    "decisionModel": { "provider": "ollama-local", "model": "tev1:4b-mxfp8" }  // 可空=纯内置打底
  },
  "enforce": "advice"
}
```

**本地决策模型接入**（原生支持，插件零协议代码）：pi 的 classifier 原生实现 `typesafe-system-one` API——在 pi 的 `models.json` 给本地端点注册一个 classifier，switchman.json 里 `decisionModel` 指向它即可：

```jsonc
// ~/.pi/agent/models.json（示意：Ollama 跑 tev1，暴露 systemone 决策端点）
{
  "providers": {
    "ollama-local": {
      "baseUrl": "http://127.0.0.1:11434/v1/systemone",
      "models": [{
        "type": "classifier", "id": "tev1:4b-mxfp8", "name": "TEv1 (local)",
        "api": "typesafe-system-one", "input": ["text"],
        "contextWindow": 32000,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
      }]
    }
  }
}
```

（`compat.imageInput` 等协议变体由 pi 按 provider/baseUrl/model 自动探测；OpenRouter、Cloudflare Workers AI、llama.cpp router 的 classifier 走同一条原生通道。云端小模型如 typesafe/jev-latest 同样即插即用。）

## 7. 文件布局

```
pi-switchman/
├── DESIGN.md                 # 本文档
├── package.json              # zero-runtime-dep（对齐 dsh 铁律）
├── src/
│   ├── index.ts              # 工厂入口，装配各层
│   ├── compress.ts           # [A] 压缩管线 + 蒸馏器（纯函数可单测）
│   ├── dispatch.ts           # [B] dispatch 工具（Tier 0/2/3 + 台账 + enforce）
│   ├── router.ts             # [C] 虚拟模型 + 双决策器 + 换/留判定
│   ├── config-ui.ts          # [F] /switchman:config TUI 配置中心
│   ├── capability.ts         # [D] 打分/推断/锚点/内置决策打底（纯函数可单测）
│   ├── watermark.ts          # [E] 仪表盘 + 保险丝 + 定制 compaction
│   ├── ledger.ts             # appendEntry 台账读写 + getBranch 重建
│   └── protocol.ts           # 字节稳定引导协议文本
├── agents/                   # 出厂 agent 定义（reviewer / scout / tester）
└── test/                     # 纯函数单测 + mock 挂载冒烟
```

## 8. 分期实施

| 里程碑 | 内容 | 独立可验证 |
|---|---|---|
| **M0** | 骨架 + 缓存宪法落地：sections 字节稳定注入、tool_result 透传（先不压）、`/switchman:status` 命令 | 开 `showCacheMissNotices` 观察无额外 miss |
| **M1** | 入口压缩 + expand 工具 | 大 bash/read 结果入栈前后 `/session` 对比 token；expand 取回原文 |
| **M2** | dispatch 工具（gather/judge/run）+ 台账 + virtual→physical 解析 | gather 不污染 transcript；run 出隔离报告；重复派发被台账拦下 |
| **M3a** | switchman/auto + 能力层 + 内置决策打底 + 泳道粘滞 | footer 显示 `auto → 物理`；泳道判定/换留全链路（无决策模型也自治）；换 provider 后候选集自动变 |
| **M3b** | 决策模型接入（classify 门 + 超时兜底）+ TUI 配置中心 | 配好 tev1 后决策走 classifier、拔掉端点自动落回内置打底；TUI 编辑泳道/排序/阈值即存即生效 |
| **M4** | 水位仪表盘 + force 定制 compaction | 长会话到 force 自动压缩且摘要含未决派发清单 |
| **M5**（可选） | codemode 协同预设、agents 库充实、小模型摘要压缩 | — |

## 9. 验证策略

- **纯函数单测**：蒸馏器（各工具形态+阈值边界）、能力推断（未见型号、折叠匹配）、路由决策表（reason×state×置信度矩阵）、enforce 匹配。
- **mock 挂载冒烟**：fake ExtensionAPI 驱动 tool_result/appendEntry/registerVirtualModel 全链（沿用 dsh 版 mock 组做法）。
- **live 清单**：`showCacheMissNotices: true` 下 M0 无新增 miss；`--mode json` 子进程回放验证 Tier 3；`/session` 看 per-model usage 与 dispatch usage 记账一致。

## 10. 风险与开放问题

| 风险 | 对策 |
|---|---|
| 压缩丢信号 | 阈值免检清单（error/小结果）+ 路径引用 + expand 正门；引导协议写明"先看蒸馏再决定取原文" |
| 模型对抗压缩（反复索要原文） | expand 是有意的正门，不限流；实测若滥用再加每轮次数提示 |
| dispatch Tier 0 被滥用成"隐藏的自由工具调用" | steps 白名单限只读工具；写入类必须走 transcript（审计与回滚需要） |
| 子进程开销（Tier 3 常态化） | 引导协议明确"Tier 3 是例外"；水位 soft 引导优先 Tier 0/1 |
| classifier 延迟落在首 token 前 | 只在 user 边界 + decisionIntervalMs 限频 + decisionTimeoutMs 超时兜底 |
| 决策端点挂死/网络抖动 | classify() never-rejects + AbortSignal 超时 → 内置打底无缝接管；router state 记录 by=classifier/builtin 供 /switchman:status 观测 |
| TUI 组件仅 tui 模式可用 | 配置双通道（JSON 永远可手改）；非 tui 模式命令退化为快照打印 |
| codemode 默认关闭 | M5 才涉及；启用由用户 `defaultTools` 决定，插件只提预设 |
| 开放：Tier 0 steps 的并行语义（全部并行 vs 显式分组） | 倾向 `parallel: steps[]` 数组内并行、多组串行——评审定 |
| 开放：ledger 是否需要在 HTML 导出里渲染 | M2 定，entry renderer 一小时的事 |

## 11. 明确不做

Agent Teams、设置页 GUI、多语言 UI、/vision、白名单同步、自建 token 计量、自建压缩、自建交接、配额爬取、TUI 配置向导。

---

## 附：本设计依赖的 pi 原语清单（均已源码/文档核实）

| 原语 | 用途 | 核实处 |
|---|---|---|
| `pi.on("tool_result")` 可替换 content/structuredContent | [A] | extensions/types.d.ts ToolResultEvent |
| 嵌套 `ctx.executeTool()` 不产生 transcript 条目 | [B] Tier 0 | extensions.md Tools 节 |
| `ctx.modelRegistry.streamSimple/classify/getAvailable` | [B] Tier 2 / [D] | model-registry.d.ts |
| `pi.registerVirtualModel`（reason/previous/failed/state；state 穿越压缩、随分支） | [C] | virtual-models.md + jev-router.ts |
| Model 条目自带 `cost`(含 cacheRead/Write/分档)/`input`/`reasoning`/`contextWindow`/`promptCache` | [D] | pi-ai types.d.ts BaseModel/Model/ModelCost |
| `ctx.getContextUsage()` / `ctx.compact()` | [E] | extensions/types.d.ts ExtensionContext |
| `pi.registerCommand` + `ctx.ui.custom()`（全屏/overlay 自定义组件） | [F] | tui.md custom screens 节 |
| `@earendil-works/pi-tui`（`SettingsList`/`SelectList`；宿主提供包，peerDependencies `"*"` 声明） | [F] | tui.md 组件节 + packages.md |
| `session_before_compact`（自定义摘要+details） | [E] | compaction.md |
| `pi.appendEntry`（不进上下文、随分支、可重建） | 台账 | extensions.md State 节 |
| `before_agent_start.systemPromptOptions.sections`（keyed、字节可稳定） | 协议注入 | system-prompt.d.ts |
| 子进程 `pi --mode json --no-session --model --append-system-prompt` | [B] Tier 3 | subagent 示例 index.ts |
| classifier 原生支持 `typesafe-system-one` API（models.json 注册 provider+model；compat 自动探测；OpenRouter/WorkersAI/llama.cpp 同通道） | [C] 决策模型 | models-configuration.md §typesafe-system-one + custom-provider.md |
| `ctx.modelRegistry.classify()`（never-rejects；options.signal 超时） | [C] | model-registry.d.ts |
| agent 定义文件每次派发时重新发现（mid-session 编辑生效） | [B] Tier 3 | subagent 示例 README |
