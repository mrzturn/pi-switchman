# pi-switchman

[pi](https://github.com/earendil-works/pi) 的上下文经济学引擎——dsh-switchman 调度理念的 pi 原生重设计。

> 管住每一个进入上下文的 token（入口压缩），把工作派到成本最低的执行层（分层执行矩阵），让模型选择只在一个入口发生（sticky 虚拟模型路由）。

**状态**：M0+M1 完成（协议段 + 入口压缩管线 + expand 工具 + `/switchman-status`）。设计文档见 [DESIGN.md](./DESIGN.md)，里程碑规划见其 §8。

## 当前能力

- **入口压缩**：超大工具结果在进入 transcript 前被蒸馏（保留头尾 + 省略标记），全文落盘，footer 给出路径——不污染缓存前缀，零缓存代价
- **expand 工具**：按 1-indexed 行号读取任何已存全文的任意片段（正门，不限流）
- **字节稳定协议段**：`[SWITCHMAN:DOCTRINE]` 引导段对给定配置字节恒定（缓存宪法）
- **fail-open**：一切钩子失败降级为放行，绝不阻塞工具

## 使用

```bash
# 试运行（无需安装）
pi --extension ./src/index.ts

# 安装为用户扩展
ln -s "$(pwd)/src" ~/.pi/agent/extensions/pi-switchman
```

配置（全部可省，默认即启用压缩）：

```jsonc
// ~/.pi/agent/switchman.json           全局
// <project>/.pi/switchman.json         项目级（覆盖合并）
{
  "compress": { "threshold": 8000, "readHead": 60, "readTail": 20 },
  "disabled": false
}
```

会话内 `/switchman-status` 查看配置来源、压缩统计与存储目录。

## 开发

```bash
bun add -d @earendil-works/pi-coding-agent @earendil-works/pi-ai   # 仅测试需要
npm test                                                          # node --test，16 个用例
```

零运行时依赖（peerDependencies `"*"`，由 pi 宿主提供副本）；`node_modules/` 仅开发用，已 gitignore。

## License

MIT
