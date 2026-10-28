# pi-switchman

[pi](https://github.com/earendil-works/pi) 的上下文经济学引擎——dsh-switchman 调度理念的 pi 原生重设计。

> 管住每一个进入上下文的 token（入口压缩），把工作派到成本最低的执行层（分层执行矩阵），让模型选择只在一个入口发生（sticky 虚拟模型路由）。

**状态**：M0–M4 完成。设计文档见 [DESIGN.md](./DESIGN.md)。

## 能力总览

| 层 | 能力 |
|---|---|
| **[A] 入口压缩** | 超大工具结果进 transcript 前蒸馏（保头尾+省略标记），全文落盘 footer 留路径；`expand` 工具按行号取任意片段；hard 水位自动收紧阈值 |
| **[B] 执行矩阵** | `dispatch` 工具四模式：`gather`（内嵌只读步骤编排，过程零入栈）/ `judge`（泳道模型单发裁决）/ `run`（隔离子进程 subagent）/ `parallel`（≤8 任务并行）；每次派发入台账（防重复派发 + 压缩保真） |
| **[C] sticky 路由** | `switchman/auto` 虚拟模型：continuation/retry 粘滞保缓存；user 边界双决策器（本地决策模型 + 内置规则打底）判泳道；缓存窗口 + 置信度双闸决定换/留 |
| **[D] 能力知识层** | 候选集活目录现查；锚点 > 名字/价格启发式推断 > 目录顺序；泳道未配置自动排序 |
| **[E] 水位** | soft→引导派发 / hard→压缩收紧 / force→台账感知的定制 compaction（10 分钟冷却） |
| **[F] TUI 配置** | `/switchman-config`：泳道×有序模型表（↑↓调序）、决策模型选择、即存即生效；JSON 文件永远可手改 |

出厂 agents：`scout`（侦查）/ `reviewer`（独立复审）/ `tester`（测试分诊）/ `worker`（通用实现）。

## 使用

```bash
# 试运行
pi --extension ./src/index.ts

# 安装为用户扩展（含出厂 agents）
ln -s "$(pwd)/src" ~/.pi/agent/extensions/pi-switchman
mkdir -p ~/.pi/agent/agents
for f in agents/*.md; do ln -s "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f"); done

# 路由：/model 里选 switchman/auto；配置：/switchman-config；状态：/switchman-status
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
    "decisionModel": { "provider": "ollama-local", "model": "tev1:4b-mxfp8" }
  }
}
```

**本地决策模型**：pi 原生支持 `typesafe-system-one` classifier——在 `~/.pi/agent/models.json` 给本地端点（如 Ollama 暴露的 systemone 决策端点）注册 classifier，`decisionModel` 指向它即可；决策端点挂掉自动落回内置规则链，路由永不断。

## 开发

```bash
bun add -d @earendil-works/pi-coding-agent @earendil-works/pi-ai   # 仅测试需要
npm test                                                          # node --test，48 个用例
```

零运行时依赖（peerDependencies `"*"`，由 pi 宿主提供）；`node_modules/` 仅开发用。

## License

MIT
