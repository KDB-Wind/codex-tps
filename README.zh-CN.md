<div align="center">

# Codex TPS

每轮回复结束，查看生成速度与历史对照。

[English](README.md) · **简体中文**

[![CI](https://github.com/KDB-Wind/codex-tps/actions/workflows/test.yml/badge.svg)](https://github.com/KDB-Wind/codex-tps/actions/workflows/test.yml)

[快速开始](#快速开始) · [速度怎么读](#速度怎么读) · [查询与诊断](#查询与诊断) · [文档](docs/README.md)

</div>

为 Codex CLI 自动显示本轮、近期和会话三个生成 TPS 估计。自动 Hook 只运行本地固定脚本，不额外请求模型；保留可选的 `$tps` / `$tps-doctor` 查询。

```text
⚡ 生成 TPS 估计 · 本轮 ≈32.8 tok/s · 近期完整 ≈35.2 tok/s（5轮） · 会话完整 ≈34.6 tok/s（12轮） · 输出 2.5k tok
```

示例用于说明输出格式，不代表模型速度基准。完整计时显示本轮估计；部分计时显示“本轮已测”及输出 token 覆盖率；没有可信样本时显示“暂不可测”及原因。

## 快速开始

需要 Node.js `>= 22.5.0`，且 Hook 进程能从 `PATH` 找到 `node`；Codex 需要支持 marketplace 插件与 Stop Hook。已验证的 CLI 和平台见[支持范围](docs/troubleshooting.md#要求与验证范围)。

```shell
codex plugin marketplace add KDB-Wind/codex-tps --ref main
codex plugin add codex-tps-plus@kdb-wind
codex plugin list --json
```

仓库名称为 `codex-tps`；为兼容已有安装，插件标识仍为 `codex-tps-plus@kdb-wind`。

1. 确认 `codex-tps-plus@kdb-wind` 为 `installed`、`enabled`。
2. 打开 `/hooks`，审核并信任 `hooks/collector.mjs` 的同步显示命令与 `hooks/backfill.mjs` 的后台回填命令。
3. 新开会话加载 Hook 与查询 Skill。正常对话结束后即可自动显示统计。

## 速度怎么读

| 速度 | 统计范围 |
| --- | --- |
| 本轮 / 本轮已测 | 完整时覆盖全部普通响应；部分时仅统计已验证响应并附 token 覆盖率 |
| 近期完整 / 近期已测 | 本会话最近最多 5 个同设置、同覆盖类型的有效轮次 |
| 会话完整 / 会话已测 | 本会话全部已保存的同设置、同覆盖类型有效轮次 |

历史值匹配记录中的模型、提供方和推理强度，按总 token 间隔 / 总生成窗口时长加权；括号内是实际有效轮数。完整与部分历史分别计算，主行选择与本轮结果相同的类型；本轮没有样本时优先显示完整历史，完整历史也没有样本时才显示明确标注的部分历史。未知设置保留为未知。最新历史样本超过一小时，或其后已有至少 5 个同设置轮次时，标注“旧样本”。

生成估计包含推理及其他有可靠计时的输出，排除窗口前的首字等待、可识别的工具执行和压缩。客户端日志不是服务端逐 token 解码追踪，窗口内部仍可能包含停顿，因此结果始终标为估计。

部分计时也能提供参考，但不代表整轮速度：

```text
⚡ 生成 TPS 估计 · 本轮已测 ≈60.0 tok/s（覆盖74.9%） · 近期已测 ≈58.2 tok/s（5轮） · 会话已测 ≈57.6 tok/s（12轮） · 输出 10.5k tok
```

覆盖率是已测普通输出 token / 全部普通输出 token。部分样本可能偏向容易取得计时的响应，不宜作为整轮或模型速度基准。本轮没有可信样本时，历史值仍可独立显示：

```text
⚡ 生成 TPS 估计 · 本轮 暂不可测（工具计时未匹配） · 近期完整 ≈35.2 tok/s（5轮） · 会话完整 ≈34.6 tok/s（12轮） · 输出 2.5k tok
```

短输出会标注；单 token 输出不可测。默认输出数排除已识别压缩，JSON 保留总用量和范围拆分。TTFT 与整轮吞吐仅在详情中提供。完整公式、覆盖规则和字段语义见[指标说明](docs/metrics.md)。

## 查询与诊断

在 Codex 输入 `$tps` 查询统计，或 `$tps-doctor` 检查安装与不可测原因。Skill 的 AI 回复会使用该次对话的 token；自动 Hook 不额外请求模型。

也可以在仓库根目录直接运行本地命令：

```shell
node plugins/codex-tps-plus/scripts/status.mjs --session-id <session-id> --details
node plugins/codex-tps-plus/scripts/status.mjs --session-id <session-id> --json
npm run doctor -- --json
```

有 `CODEX_THREAD_ID` / `CODEX_SESSION_ID` 的终端可省略会话参数。参数详情见[本地查询说明](plugins/codex-tps-plus/docs/local-commands.md)。

- **没有显示**：检查插件启用、Hook 信任、新会话和 Node，运行 doctor；步骤见[排障说明](docs/troubleshooting.md#没有显示指标)。
- **显示不可测**：查看 JSON 的 `latest.generation.exclusionReasons`；解析缺口、用量冲突、范围未确认或缺少计时仍可能阻止可信样本。安装通过不代表计时覆盖完整。
- **三项速度相同**：单个有效样本，或近期恰好覆盖全部有效历史时，这是正常结果。

## 升级

```shell
codex plugin marketplace upgrade kdb-wind
codex plugin add codex-tps-plus@kdb-wind
```

新开会话加载新版 Hook 定义和 Skill。已有会话可使用自动保存的稳定 Hook 快照；Hook 定义变化后需要重新审核。

## 数据与隐私

正常统计仅保存哈希化标识、数字指标、计时覆盖与固定排除原因，以及经过校验的模型标签，不保存 prompt、回复正文、工具参数或原始 ID。统计链路不向网络发送会话数据。

每会话最多保留 200 个状态文件、合计 2 MiB；会话速度按保留记录计算。另保留最多 5 个生产 Hook 代码快照供升级恢复。存储与处理链路见[工作机制](docs/architecture.md)。

## 开发与验证

0.7.5 增加部分覆盖显示、独立历史、文件修改计时和后台命令关联。验证证据与限制见[候选验证记录](plugins/codex-tps-plus/reports/0.7.5-candidate.md)。CI 覆盖 Windows/macOS/Linux × Node.js 22/24，以及 CLI 0.153.4、0.159.2、0.160.0 的安装/升级。

安装冒烟使用合成 Hook 输入，不发送模型请求；这不等于三个平台的交互界面均已实测，也不是 TPS 精度基准。

```shell
npm test
npm run release:check
npm run smoke:install
```

## 文档

- [指标口径与结果解读](docs/metrics.md)
- [工作机制与数据存储](docs/architecture.md)
- [安装、支持范围与排障](docs/troubleshooting.md)
- [高级实验与历史证据](docs/experiments.md)
- [文档与版本证据索引](docs/README.md) · [更新记录](CHANGELOG.md) · [发布检查](RELEASE-CHECKLIST.md)

## License

[MIT](LICENSE)
