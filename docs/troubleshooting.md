# 安装、支持范围与排障

[返回项目首页](../README.md) · [文档索引](README.md)

安装与升级命令见[项目首页](../README.md#快速开始)，查询参数见[本地查询说明](../plugins/codex-tps-plus/docs/local-commands.md)。

## 要求与验证范围

- Node.js `>= 22.5.0`，且 `node` 能从 Hook 进程的 `PATH` 找到。
- Codex 需要支持 marketplace 插件与 Stop Hook；支持本地 Codex 插件 Hook 的桌面界面也可使用相同链路。
- 0.7.4 的跨平台 CI 覆盖 Windows、macOS、Linux × Node.js 22/24，以及 CLI `0.153.4`、`0.159.2`、`0.160.0` 的隔离安装/升级。[对应提交的 12 个 CI 任务](https://github.com/KDB-Wind/codex-tps/actions/runs/37050730180)全部通过。
- CI 用合成输入调用已安装的 Hook，不能替代各平台交互式界面的实测，也不是 TPS 精度基准。macOS/Linux 交互式界面尚未独立验证；生成速率尚未与受控流式响应对照验证误差。
- 历史 Windows 交互实测覆盖 CLI `0.149.1` 的 Hook 时序与 `0.153.4` 的安装和显示；这些是已有版本的证据，不代表所有后续版本均已交互验证。
- 历史实验中 `codex exec` 没有运行项目 Hook，目前支持承诺以交互式会话为准。

## 常见问题

### 为什么三项速度相同

只有一个有效样本时，本轮、近期、会话可能相同。近期使用最近最多 5 个同设置有效轮次；若这些轮次恰好覆盖全部已保存的同设置有效轮次，近期与会话相同也是正常结果。

切换模型、提供方或推理强度后，比较对象随当前轮设置切换。未知设置不推断，完整有效样本少于总轮数时只标注实际纳入的轮数。

### 自动统计与 Skill 是否消耗模型 token

自动 Stop Hook 执行固定的本地脚本，不发起额外模型请求、不启动新 turn、不向模型追加统计上下文。`$tps` / `$tps-doctor` 是方便的 AI 查询，其回复会使用该次对话的 token；直接运行本地查询脚本不调用模型。

### 没有显示指标

依次检查：

1. `codex plugin list --json` 中插件是否 installed/enabled；
2. `/hooks` 中当前 Hook 定义是否已信任；
3. 安装或升级后是否新开了会话；
4. `node --version` 是否满足要求；
5. 在仓库根目录运行 `npm run doctor -- --json`，检查安装项是否全部通过。

无输出 token、找不到当前 turn、turn 超过 16 MiB 尾部上限或 transcript 暂时不可读时，
插件也会有意不显示指标。

### 升级后旧会话出现 `hook exited with code 1`

活动会话会保留启动时的版本化 `PLUGIN_ROOT`。从支持稳定运行快照的版本开始，正常完成一次 Stop 会自动
保存稳定运行时；后续升级即使清理旧缓存，历史会话也会转到该快照，最差返回空 JSON，
不应再出现退出码 1。仍建议升级后新开会话，以加载新版 Hook 定义和查询 Skill。

早于这一兼容机制创建的内部开发会话无法被旧 Hook 命令追溯改写；它们需要一次性恢复旧
路径或结束会话。这不影响首次安装包含这一机制的版本的用户。

### 为什么查询一直没有 TTFT

正常情况下，后台 Stop 处理器会在 `task_complete` 落盘后回填当前轮。若历史会话没有加载
这个异步处理器，下一轮同步 Stop 会自动从 transcript 补偿回填上一轮，不需要重新配置。
第一轮仍可能没有 TTFT，因为当轮的完成事件必然晚于同步 Stop。

### 为什么数值比其他 TPS 工具低

0.7.4 在完整计时覆盖时提供本轮生成 TPS 估计，同时显示近期与会话加权值；若显示不可测，请在 `$tps` 或本地 JSON 查询中查看
`latest.generation.exclusionReasons`。工具密集的轮次可能缺少可靠的参数生成计时，不能保证每轮均有生成速率。


0.6.0 的主分子排除了 reasoning，分母包含 TTFT、工具和其他整轮等待；其他工具可能把
reasoning 算进分子，或只使用首 token 到末 token 的纯解码时间。口径不同，数值不能直接
比较。`scripts/status.mjs --json` 同时保留 `totalOutputThroughput` 和请求区间诊断用于排查
差异。

### 为什么第一轮没有 TTFT

Codex 在同步 Stop 完成后才把 `task_complete.time_to_first_token_ms` 写入 transcript。插件
不会用估算值替代它；后台回填后可用本地状态脚本查询。`status.mjs --verbose` 保留“最近有效 TTFT”及来源；默认自动行只显示生成估计/不可测与输出数。

### 为什么 OTel 参考仍不叫本轮 TPS

OTel service TBT 是真实的 Codex engine timing，但当前验证样本没有可稳定关联到 Stop 的
request/turn ID。多请求被合并进 histogram，指标又在进程结束附近批量 flush；窗口时间是
聚合边界，不是逐 token 到达时刻。插件只把显式捕获的倒数换算值标成“捕获参考”或
“单轮候选”，并始终带“未归轮”。
