# pi-switchman

[pi](https://github.com/earendil-works/pi) 的上下文经济学引擎——dsh-switchman 调度理念的 pi 原生重设计。

> 管住每一个进入上下文的 token（入口压缩），把工作派到成本最低的执行层（分层执行矩阵），让模型选择只在一个入口发生（sticky 虚拟模型路由）。

**状态**：M0–M4 完成。设计文档见 [DESIGN.md](./DESIGN.md)。

## 能力总览

| 层 | 能力 |
|---|---|
| **[A] 入口压缩** | 超大工具结果进 transcript 前蒸馏（保头尾+省略标记），全文落盘 footer 留路径；`expand` 工具按行号取任意片段；hard 水位自动收紧阈值 |
| **[B] 执行矩阵** | `dispatch` 工具四模式：`gather`（内嵌只读步骤编排，过程零入栈）/ `judge`（泳道模型单发裁决）/ `run`（隔离子进程 subagent）/ `parallel`（≤8 任务并行）；每次派发入台账（防重复派发 + 压缩保真）；**子智能体工作可视**：每个 run agent 写人类可读日志；tmux 内在当前窗口左右分屏——pi 主格居左，右列最多 2 格上下均分直播，超出的后台排队，格子空出即 `respawn` 无缝接位，全部收工自动恢复主格全屏；非 tmux 用 `/switchman-agents [n]` 列表/钻取 |
| **[C] sticky 路由** | `switchman/auto` 虚拟模型：continuation/retry 粘滞保缓存；user 边界双决策器（本地决策模型 + 内置规则打底）判泳道；缓存窗口 + 置信度双闸决定换/留；**图像闸门**：请求带图（read 工具的图像结果或 API 附件）而当前模型不读图时，优先于一切粘滞强制改道 vision 泳道；**图像中继**：大上下文（≥ `router.visionRelayThresholdTokens`，默认 50k，0 关闭）时不冷切，由 vision 泳道小请求描述图片注入对话（用户附件在 before_agent_start 拦截，read 工具结果在 tool_result 拦截替换），当前模型缓存无损，失败自动回落整回合切换；**死回合接续**：pi 在响应出错后的阈值压缩只压不接（Case 3 无 retry），turn_end 检测到「errored assistant + 尾部压缩」死回合时自动发 [SWITCHMAN:CONTINUE] 接续 |
| **[D] 能力知识层** | 候选集活目录现查；锚点 > 名字/价格启发式推断 > 目录顺序；泳道未配置自动排序 |
| **[E] 水位** | 每档双形态阈值：百分比（0–100）或绝对 token（如 tokens: 80000），两者同配时按实际窗口换算取小者生效；soft→引导派发 / hard→压缩收紧 / force→提示 pi 自动压缩（单压缩者原则；台账经 session_before_compact 快照、session_compact 后确定性还原）；死回合（stopReason=error）自动接续 |
| **[F] TUI 配置** | `/switchman-config`：泳道×有序模型表（↑↓调序）、决策模型选择、即存即生效；JSON 文件永远可手改 |

出厂 agents：`scout`（侦查）/ `reviewer`（独立复审）/ `tester`（测试分诊）/ `worker`（通用实现）。

内置 skills（随包安装自动发现，`/skill:<name>` 显式调用）：`git-commit-message`（只产出提交文案，不碰 git 写操作）/ `db-query`（MySQL/Redis 只读核查，自带加固过的查询脚本）/ `requirement-docs`（带证据链的需求/设计/计划文档）。输出语言遵循 `switchman.json` 的 `skills.language`（`default` + 按类别 `commit`/`docs`/`db` 覆盖，项目层覆盖全局层），当场指令的语言优先级最高；机器标记与协议文本保持英文稳定。

## 安装

**方式一：pi 包（推荐，一条命令）**

```bash
pi install git:github.com/mrzturn/pi-switchman
```

出厂 agents（scout/reviewer/tester/worker）已编译为内置兜底——未放置任何 agent 文件时自动可用；放入 `~/.pi/agent/agents/*.md` 可覆盖。升级：`pi update --extensions`。

**方式二：开发安装（本仓库 clone 后）**

```bash
# 试运行
pi --extension ./src/index.ts

# 安装为用户扩展（含出厂 agents 文件版，覆盖内置）
ln -s "$(pwd)/src" ~/.pi/agent/extensions/pi-switchman
mkdir -p ~/.pi/agent/agents
for f in agents/*.md; do ln -s "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f"); done
```

> 非 npm 包：宿主依赖（pi-ai / pi-agent-core / pi-coding-agent）由 pi 提供，`peerDependencies: "*"`，无需 `npm install`。

## 使用

```bash
# 路由：/model 里选 switchman/auto；配置：/switchman-config；状态：/switchman-status；子智能体日志：/switchman-agents
```

配置（全部可省，开箱即用；TUI 只是 JSON 的编辑器）：

```jsonc
// ~/.pi/agent/switchman.json（全局）· .pi/switchman.json（项目级，覆盖合并）
{
  "compress": { "threshold": 8000 },
  "watermark": { "soft": 0.7, "hard": 0.85, "force": 0.95 },
  "enforce": "advice",
  "anchors": [{ "provider": "anthropic", "model": "claude-opus-4-5", "tier": "heavy" }],
  "router": {
    "lanes": { "hard": [{ "provider": "anthropic", "model": "claude-opus-4-5" }] },
    "switchConfidence": 0.8,
    "cacheWindowMs": 300000,
    "decisionEndpoint": {
      "provider": "switchman-decision",
      "baseUrl": "http://127.0.0.1:11434/v1/systemone",
      "model": "tev1:4b-mxfp8"
    }
  }
}
```

**本地决策模型**：两种配置部路——
- **TUI**：`/switchman-config` → decision 行 → `── add local endpoint (provider + model)…`，填 provider 名、systemone 端点 URL、模型 id（可选 API key），确认即保存并立即注册（无需重启）；
- **手改 JSON**：如上例的 `router.decisionEndpoint`，扩展启动时自动注册为 typesafe-system-one classifier，`decisionModel` 会同步指向它。
端点挂掉自动落回内置规则链，路由永不断；也可不用本地端点，直接在 models.json 注册任意 classifier 后在 TUI 选择。

## 开发

```bash
bun add -d @earendil-works/pi-coding-agent @earendil-works/pi-ai   # 仅测试需要
npm test                                                          # node --test，48 个用例
```

零运行时依赖（peerDependencies `"*"`，由 pi 宿主提供）；`node_modules/` 仅开发用。

## License

MIT
