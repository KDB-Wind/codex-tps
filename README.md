# codex-tps-plus

[![test](https://github.com/KDB-Wind/codex-tps-plus/actions/workflows/test.yml/badge.svg)](https://github.com/KDB-Wind/codex-tps-plus/actions/workflows/test.yml)

为 Codex CLI 在每轮回复结束后显示本轮、近期、会话三个生成 TPS 估计。0.7.4 的自动 Hook 只运行本地固定脚本，不调用模型、不发起统计请求；保留可选 `$tps` / `$tps-doctor` 查询。计时覆盖完整时显示估计，证据不足时显示“暂不可测”；整轮吞吐与 TTFT 仅在详情中提供。

```text
⚡ 生成 TPS 估计 · 本轮 ≈32.8 tok/s · 近期 ≈35.2 tok/s（5轮） · 会话 ≈34.6 tok/s（12轮） · 输出 2.5k tok
```

计时证据不足时：

```text
⚡ 生成 TPS 估计 · 本轮 暂不可测（工具计时未匹配） · 近期 ≈35.2 tok/s（5轮） · 会话 ≈34.6 tok/s（12轮） · 输出 2.5k tok
```

## 它显示什么

| 指标 | 计算口径 | 使用范围 |
|---|---|---|
| 生成 TPS 估计 | 各普通响应 `(output_tokens - 1)` 之和 / 对应客户端输出窗口秒数之和 | 用量与窗口覆盖均完整时显示；包含推理及可确认计时的工具参数，排除已识别压缩，不是服务端纯解码测量 |
| 近期生成 TPS 估计 | 同记录设置最近最多 5 个有效轮次的总 token 间隔 / 总生成窗口秒数 | 自动行标注实际有效轮数，单个样本不代表稳定趋势 |
| 会话生成 TPS 估计 | 同记录设置的全部已保存有效轮次的总 token 间隔 / 总生成窗口秒数 | 自动行标注纳入的有效轮数，历史记录受保留上限约束 |
| 非推理整轮吞吐 | `(output_tokens - reasoning_output_tokens) / 整轮秒数` | 仅在详情中显示，包含首字等待、工具执行与客户端开销 |
| 总输出整轮吞吐 | `output_tokens / 整轮秒数` | 仅在详情中显示 |
| TTFT | 完成事件的 `time_to_first_token_ms` | 后台回填后查询，默认行不附带其他轮次的 TTFT |

默认行包含本轮、近期、会话三个明确标注的生成 TPS 估计，以及输出数。本轮不可测时保留原因；历史没有有效样本时显示“暂无有效样本”，不显示 0 或借用另一项。`scripts/status.mjs --json` 提供用量拆分、覆盖率、排除理由、整轮耗时及 TTFT。
`status.mjs --verbose` 保留旧版详细整轮吞吐行与可选 OTel 参考。

`status.mjs --details` 输出当前结果、响应/输出 token 的计时覆盖率，以及近期同记录设置加权速率；
`--recent` 单独显示近期比较。`recentGeneration` 取本会话最近 5 个有效轮次，要求记录中的模型、
provider、推理强度一致，按 token 间隔总数除以生成时间总数加权。未知设置明确标注未知；
旧计时方法及不可测轮次不参与，不把历史均值替代当前轮的不可测状态。JSON 包含样本数、排除数、样本捕获时间与当前轮是否入选。

`sessionGeneration` 使用相同过滤和加权规则，取全部已保存的同设置有效轮次；`sampleLimit=null`，
`historyScope=retained-session-records`。现有保留上限为每会话 200 个状态文件 / 2 MiB，超过后裁剪旧文件，
所以会话值按当前保留的有效记录计算。近期和会话都匹配当前轮记录的模型、provider、推理强度，切换设置后不混算。

`latest.generation.available` 和 `coverageComplete` 同时为 true，且 `measurementVersion` 为 3，才展示生成 TPS 估计；工具先出现、零时长起点、缺失/冲突输出项、无法确认工具参数结束点、未知 reasoning 用量、推理/正文计时缺失、未归类响应、未覆盖的旧用量记录或未配对输出均显示不可测。
匹配窗口覆盖一个响应中从可靠输出起点至最后生成完成的整个时间跨度，重叠输出项只计算一次，保留期间的间隔；工具执行开始后才写入的调用记录不能冒充参数生成结束点。
短输出在默认行标注，不按固定速度阈值删除数据。单 token 没有 token 间隔，保持不可测。日志缺失时不把部分有效响应冒充整轮的完整速度。

0.7.3 先收集整轮证据，再判定每个响应。模型输出项按 ID 回补迟到的计时；工具执行优先按调用 ID
关联，外层调用与内部项 ID 不同时，使用具有相同 `call_id` 的调用/返回边界核验唯一归属。
跨响应边界重叠、执行与输出重叠、返回身份缺失或时间冲突均保持不可测。推理用量明确为 0，
且对应推理项没有可见摘要/正文时，空推理占位项不参与正文计时；加密内容不作 token 估计。
完成事件落盘后，后台再读取一次有上限的日志以更新保存的生成证据；已显示的 Hook 行不会被改写。

`token_usage_record.usage` 按响应 ID 去重，旧 `token_count` 镜像不重复相加，未覆盖的旧响应只补用量。相同 token 数的不同响应保持独立，冲突的显式记录使当前轮指标不可用。
旧快照在新 turn 中重播且累计输出与上一轮末尾相同时，不作为新响应计数；缺少上一轮基线时不凭相同 token 数猜测去重。
总用量包含已计入的所有响应；`responseMetrics.scopes` 单列普通、压缩和未归类用量。压缩关联依赖相邻完成记录，无法确认的范围保持未归类。

`output_tokens` 已包含 reasoning，不再加一次。非推理输出也可能包含工具参数，不等于只对最终正文做分词。
`modelGroups` 按本轮观察到的模型、provider、reasoning effort 分组，并以 token 与时长加权；未知设置保持独立。旧 `session` 与 `metric` 字段保留兼容，可能混合不同模型，不作为同模型速度比较。

## 工作机制

插件只注册一个 `Stop` 事件，其中有两个命令处理器：同步显示和后台完成时长/TTFT 回填。

1. Codex 完成一轮回复并触发 Stop；同步处理器与官方 `async: true` 后台处理器并发启动。
2. 同步处理器在当前 `PLUGIN_ROOT` 可用时，把生产 Hook 所需代码按内容哈希保存到不含
   版本号的 `PLUGIN_DATA/runtime`，最多保留 5 份代码快照。指针和调度器采用临时文件
   替换；快照失败不会影响本轮指标。
3. 同步处理器从 transcript 尾部读取 256 KiB；找不到当前 `task_started` 时逐步扩大，最多读取
   16 MiB，不会在正常模式下复制或保存整份会话正文。
4. 解析当前 turn 的显式逐响应用量、计时输出项及旧 `token_count`，并排除其他 turn/thread 的记录。
5. 优先以响应 ID 关联显式用量；旧记录使用累计 `total_token_usage.output_tokens` 去重。未被显式记录覆盖的非零旧 usage
   缺少累计值时无法可靠区分重复广播与新请求，该轮返回 `token_usage_deduplication_unavailable`，
   不显示速率、不写入会话统计；不会仅因两个请求的 token 数相同而合并它们。
6. 收集全部调用/返回及模型项，再统一关联计时并排除工具执行区间。校验推理/非推理 token 的计时覆盖；普通响应均有效时，按各响应 N−1 个间隔计算生成 TPS 估计，否则主行显示不可测及简短原因。Stop 墙钟只用于详情中的暂定整轮吞吐。
7. 旧版的请求区间重建仍写入 JSON 供兼容诊断，但 transcript 没有稳定的逐请求生命周期
   契约，因此它不再进入默认状态行。
8. 同步处理器还会检查当前 turn 之前最近一条完整的 `task_complete`；如果异步处理器未曾
   回填，就为上一轮补写完成时长和 TTFT。这让旧会话或偶发异步失败能在下一轮自动恢复。
9. 同步处理器将哈希 ID、数字状态和经过字符白名单校验的模型标签原子写入 `PLUGIN_DATA`，再通过严格 JSON `systemMessage`
   把指标显示为 Codex UI 事件。
10. 后台处理器最多等待 10 秒；首次最多扫描 16 MiB 尾部，后续只读取追加的字节，文件未变化
    时跳过内容读取。支持半行写入、文件截断和替换。当前 turn 的 `task_complete` 落盘后，分别校验并回填 TTFT、
    完成时长、哈希 turn ID 和时间来源。完成时长会替代 Stop 墙钟成为该轮及会话的权威
    分母；缺少其中一个 timing 不会丢弃另一个。处理器输出空 JSON，不启动新 turn，也不给
    模型增加上下文。同一 turn 再次触发 Stop 时保留已回填的 timing 和原始记录时间，避免
    精确分母丢失或旧轮次被误排到最新。

Hook 命令会先运行会话启动时的版本目录；如果插件升级已经清理该目录，则自动调用
`PLUGIN_DATA/runtime/dispatch.mjs` 中最近一次成功保存的快照。两处都不可用或系统找不到
Node 时只返回 `{}`，不会用退出码 1 干扰旧会话。

由于当前轮 completion timing 在同步 Stop 之后才出现，详情中的整轮吞吐先使用接近完成时点的
Stop 墙钟；生成 TPS 使用独立客户端输出窗口且始终保留估计标记。默认行不展示 TTFT。后台回填后，本地 JSON 查询中的整轮吞吐会改用精确完成时长；
详情中的旧有效 TTFT 保留轮次来源。即使后台处理器没有运行，下一次同步 Stop 也会补偿回填上一轮。

这条链路依赖 Codex transcript 的事件顺序，而 transcript 不是承诺稳定的公开数据格式。
格式变化、超长 turn、缺少 token 或状态目录不可写时，插件返回空 JSON，不伪造数值。

## 要求与支持范围

- Codex CLI 或支持本地 Codex 插件 Hook 的 ChatGPT Desktop/Codex 界面。
- Node.js `>= 22.5.0`，且 `node` 可从 Hook 进程的 `PATH` 找到。
- 插件必须来自已配置的 Codex marketplace。
- Hook 生命周期与延迟 completion 时序已在 Windows、Codex CLI `0.149.1` 的交互式 TUI
  实测；0.6.0 已在 Windows、Codex CLI `0.153.4` 完成安装、doctor 与新会话显示验证，
  并通过 Windows/macOS/Linux × Node.js 22/24 的自动化测试及实际 CLI 安装/升级冒烟。
  macOS/Linux 的验证使用合成输入调用已安装的 Hook；尚未独立验证这些平台的交互式 TUI。
- 0.7.0 候选版已在本机 Windows 通过 CLI `0.153.4`、`0.159.2`、`0.160.0` 的隔离安装/升级与合成 Hook 冒烟。
  0.7.1 也通过上述三个 CLI 版本的本机隔离冒烟，并新增禁止网络与子进程访问的生产 Hook 回归。
  新版跨平台 CI 已配置，尚未运行；输出速率尚未与受控流式响应对照验证误差。
- 历史实验中 `codex exec` 没有运行项目 Hook，因此当前支持承诺以交互式会话为准。

## 安装

要求 Codex CLI `0.149.1` 或更高版本。先添加这个 Git marketplace，再安装插件：

```powershell
codex plugin marketplace add KDB-Wind/codex-tps-plus --ref main
codex plugin add codex-tps-plus@kdb-wind
codex plugin list --json
```

列表中应出现：

```text
codex-tps-plus@kdb-wind
installed: true
enabled: true
```

接下来：

1. 在 Codex 中打开 `/hooks`。
2. 审核本插件的 `Stop` Hook，确认两个命令分别指向 `hooks/collector.mjs` 和
   `hooks/backfill.mjs`；后者应标记为后台运行，然后信任它们。
3. **新开一个会话**，加载新版 Hook 定义与查询 Skill；安装
   插件也不会自动信任它的 Hook。

升级时执行：

```powershell
codex plugin marketplace upgrade kdb-wind
codex plugin add codex-tps-plus@kdb-wind
```

升级不会热替换已经运行中的会话。请新开会话加载新版 Hook 定义；已经运行或恢复的
历史会话会继续使用最近自动保存的 Hook 快照，不需要重新配置。Codex 按 Hook 定义哈希记录
信任，只有定义本身变化时才会要求重新审核。

## 使用

正常使用不需要任何环境变量。完成一轮回复后会自动出现统计行；后台处理器最多等待
10 秒回填完成时长与 TTFT，不会阻塞回复。

在 Codex 输入 `$tps` 查询当前会话统计，或 `$tps-doctor` 检查安装与不可测原因。它们是可选 AI 查询，会使用该次对话的 token；自动 Hook 不调用模型。

也可以直接在终端运行本地脚本；在仓库根目录执行：

```powershell
npm test
npm run doctor -- --json
node plugins/codex-tps-plus/scripts/status.mjs --session-id <会话ID>
node plugins/codex-tps-plus/scripts/status.mjs --session-id <会话ID> --json
```

有 `CODEX_THREAD_ID` / `CODEX_SESSION_ID` 的终端可以省略会话参数。0.7.3 保留查询 Skill；自动统计与直接运行本地命令均不产生额外模型请求。详见 [本地查询说明](plugins/codex-tps-plus/docs/local-commands.md)。

如果已经显式采集了本地 OTLP 数据，可以附加一个只读的、未归属到当前轮的参考：

```powershell
node plugins/codex-tps-plus/scripts/status.mjs --otel-capture <otel-capture-directory> --json
```

也可在运行查询前设置 `TPS_PLUS_OTEL_CAPTURE_DIR`，让本地状态脚本读取该目录。此选项不会
启动接收器或修改 Codex 配置；原始 `.bin` 仍应视为敏感数据。

### 可选：原生 TBT 捕获实验

普通使用者不需要启用本节。它适合希望观察 Codex 原生 engine timing、并接受本地原始
OTLP 数据风险的高级用户。生产 Stop Hook 永远不会启动接收器或修改配置。

先用固定的 localhost 端口启动独占接收器：

```powershell
$capture = Join-Path $env:TEMP "codex-tps-plus-otel"
node plugins/codex-tps-plus/scripts/otel.mjs serve --output-dir $capture --port 4318
```

接收器只监听 `127.0.0.1`，同一目录只允许一个进程写入；默认单个 body 不超过 64 MiB，
最多保留 1000 个 payload、合计 512 MiB。新开一个 PowerShell，使用仅对本次 Codex 进程
生效的配置覆盖：

```powershell
$env:TPS_PLUS_OTEL_CAPTURE_DIR = Join-Path $env:TEMP "codex-tps-plus-otel"
codex `
  -c 'otel.log_user_prompt=false' `
  -c 'otel.exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/logs",protocol="binary"}}' `
  -c 'otel.metrics_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/metrics",protocol="binary"}}'
```

完成一轮后，`status.mjs --verbose` 会附加类似：

```text
原生生成 TPS ≈55.7（TBT 推算·单轮候选·未归轮）
```

这里的“单轮候选”只在一个 receiver identity、一个 conversation、一个完成 turn 的新鲜
捕获中出现；否则固定降级为“捕获参考”。两者的 `currentTurnAttributed` 都是 `false`。
`service TBT` 是 histogram：多请求可能合并为一个点，`count` 才是 observation 数；其倒数
是请求均值的近似值，不保证等于按输出 token 加权的精确 TPS。少于 128 个 turn 输出 token
时还会标记“短输出”，因为实测 5-token 回复的倒数从长回复约 55.7 降到约 9.3。

诊断显式捕获时可以运行：

```powershell
node plugins/codex-tps-plus/scripts/doctor.mjs --otel-capture $env:TPS_PLUS_OTEL_CAPTURE_DIR --json
node plugins/codex-tps-plus/scripts/otel.mjs scan $env:TPS_PLUS_OTEL_CAPTURE_DIR
```

doctor 会分别检查 receiver 是否仍存活、logs/metrics exporter 是否指向它，以及捕获中是否
出现多个 conversation。若配置只通过本次 `codex -c` 覆盖，独立 doctor 进程无法看到这些
覆盖；可用 `--config <toml>` 指向等价的检查配置。结束实验后停止 receiver，并删除准确的
临时捕获目录。

极少数情况下，旧 receiver 退出后其 PID 被系统复用，陈旧的 `receiver.lock` 会被保守地
判断为“仍有进程存活”。遇到此错误时，先确认没有任何 receiver 正在写入该捕获目录，再只
删除该目录内的 `receiver.lock` 并重启；receiver 仍在运行时不得删除锁，否则会破坏独占性。

## 输出示例与解读

```text
⚡ 生成 TPS 估计 · 本轮 ≈32.8 tok/s · 近期 ≈35.2 tok/s（5轮） · 会话 ≈34.6 tok/s（12轮） · 输出 2.5k tok
⚡ 生成 TPS 估计 · 本轮 ≈61.6 tok/s（短输出） · 近期 ≈35.9 tok/s（5轮） · 会话 ≈34.8 tok/s（13轮） · 输出 87 tok
⚡ 生成 TPS 估计 · 本轮 暂不可测 · 近期 暂无有效样本 · 会话 暂无有效样本 · 输出 200 tok
```

主行始终采用同一种生成窗口口径，不使用整轮吞吐替代缺失值。短输出标注只提示样本波动，不能视为稳定模型速度。
JSON 的 `displayMetric` 表示当前紧凑显示选择，旧 `metric` 始终保留整轮吞吐语义。
输出速率需要每个普通响应均有可靠匹配，不能通过整轮减去工具耗时或减去一次 TTFT 推算。

不同模型、推理强度、缓存、输出长度、服务档位和工具负载都会改变结果。查询 `modelGroups` 中相同条件的样本，再比较带覆盖率的加权均值；单个短回复不能作为模型速度结论。
未回填 TTFT 保持缺失，不显示为零。可选 OTel 的 TBT 参考只在详情出现，始终保留未归轮说明。

## 数据与隐私

正常运行时只持久化：

- 截断 SHA-256 后的 session/turn ID；
- total/reasoning/non-reasoning output token 数字；
- Stop 墙钟、完成时长与推断请求区间时长；
- 延迟回填的 TTFT 与 `task_complete` 完成时长；
- 请求、token 快照和工具调用计数；
- 捕获时间和 schema 版本；
- 响应范围/计时覆盖率与固定排除理由；
- 校验过的模型/provider/推理档位标签，不保存配置文件或认证值。

此外，`PLUGIN_DATA/runtime` 最多保存 5 份插件自身的生产 Hook 代码快照，用来在升级清理
旧版本缓存后继续服务历史会话。快照不包含 transcript、prompt、回复、工具参数或原始 ID。

不会持久化 prompt、assistant 正文、工具参数、命令、工作目录、transcript 路径或原始
session/turn ID。每个会话最多保留 200 个状态文件，合计最多 2 MiB；只清理符合插件
状态命名格式的文件。

生产配置只有 Stop 事件，不会在每次工具调用前后额外启动 Node 进程。每轮启动一个同步
显示进程和一个最多等待 10 秒的后台回填进程。Node 不存在、版本目录已删除、稳定快照缺失
和内部解析错误都会安静降级；宿主 shell 无法启动或进程被外部强制终止等宿主级故障仍可能
被 Codex 报告为 Hook 失败。

## 常见问题

### 没有显示指标

依次检查：

1. `codex plugin list --json` 中插件是否 installed/enabled；
2. `/hooks` 中当前 Hook 定义是否已信任；
3. 安装或升级后是否新开了会话；
4. `node --version` 是否满足要求；
5. 本地 `node scripts/doctor.mjs --json` 是否全部通过。

无输出 token、找不到当前 turn、turn 超过 16 MiB 尾部上限或 transcript 暂时不可读时，
插件也会有意不显示指标。

### 升级后旧会话出现 `hook exited with code 1`

活动会话会保留启动时的版本化 `PLUGIN_ROOT`。从本公开版开始，正常完成一次 Stop 会自动
保存稳定运行时；后续升级即使清理旧缓存，历史会话也会转到该快照，最差返回空 JSON，
不应再出现退出码 1。仍建议升级后新开会话，以加载新版 Hook 定义和查询 Skill。

早于这一兼容机制创建的内部开发会话无法被旧 Hook 命令追溯改写；它们需要一次性恢复旧
路径或结束会话。这不影响首次安装本公开版的用户。

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

## 开发与验证

```powershell
npm test
npm run release:check
npm run smoke:install
cd plugins/codex-tps-plus
node scripts/doctor.mjs --json
node scripts/analyze-transcript.mjs <transcript.jsonl>
node scripts/otel.mjs config
node scripts/otel.mjs serve --output-dir <capture-directory> --port 4318
node scripts/otel.mjs scan <otel-capture-directory>
node scripts/otel-inspect.mjs <otel-capture-directory>
node scripts/status.mjs --otel-capture <otel-capture-directory> --json
```

仓库根目录是 marketplace，插件本体位于 `plugins/codex-tps-plus`。GitHub Actions 在
Windows、macOS、Linux 上分别使用 Node.js 22 和 24 运行测试、候选检查和实际 CLI 安装/升级
冒烟验证。冒烟验证覆盖 Codex CLI 0.153.4、0.159.2 和 0.160.0，使用隔离的临时 `CODEX_HOME`，
从 0.6.0 升级并验证显式/旧镜像、压缩范围及输出窗口估计，不会发送模型请求。
正式标签构建还运行 `npm run release:verify`，检查工作区干净且标签指向当前提交。候选检查
不会创建或禁止标签；正式发布步骤见 [发布检查清单](RELEASE-CHECKLIST.md)。

仓库保留第一阶段的脱敏 transcript 探针，并将 localhost OTLP 接收器作为显式实验子命令。
它们不属于生产 Hook 注册项，也不会自动启用。

OTLP 原始 `.bin` 可能包含 prompt、工具或其他敏感属性。接收器只监听 `127.0.0.1`，但
这不等于内容已脱敏；实验结束后应删除准确的捕获目录，绝不能提交 `artifacts/otel/`。
结构化检查器只输出允许列出的结构、名称和数字，它不能证明原始 body 安全。

已验证样本中的原生 OTel TBT/TTFT 为异步批量 histogram，且没有可与当前 Stop 稳定关联的
request/turn ID，因此运行时不会把 `1000 / TBT_ms` 冒充当前轮 TPS。日志中同时出现 SSE
和 WebSocket 命名信号，而 0.149.1 的相关切换 feature 已移除，插件不会据此伪造传输类型。

详细证据见 [第一阶段验证报告](plugins/codex-tps-plus/reports/validation.md)、
[第二阶段实现说明](plugins/codex-tps-plus/reports/phase-two.md)、
[第三阶段请求区间吞吐说明](plugins/codex-tps-plus/reports/phase-three.md) 和
[第四阶段延迟 TTFT 说明](plugins/codex-tps-plus/reports/phase-four.md) 和
[第五阶段 OTel 实验报告](plugins/codex-tps-plus/reports/phase-five.md)。0.6.0 的审计证据、
冻结公式和兼容规则见 [准确性修订冻结说明](PLAN-0.6.0.md)。0.7.0 的实现、验证范围与剩余限制见 [候选版验证说明](plugins/codex-tps-plus/reports/0.7.0-candidate.md)。
0.7.1 的固定主口径与本地统计约束见 [0.7.1 验证说明](plugins/codex-tps-plus/reports/0.7.1-candidate.md)。
Skill 恢复与跨轮快照修复见 [0.7.2 验证说明](plugins/codex-tps-plus/reports/0.7.2-candidate.md)；迟到事件修复见 [0.7.3 验证说明](plugins/codex-tps-plus/reports/0.7.3-candidate.md)；三项自动显示见 [0.7.4 验证说明](plugins/codex-tps-plus/reports/0.7.4-candidate.md)。

## Roadmap

实时吞吐/TTFT/turn 级 usage 依赖 App Server 的只读会话事件流；phase-six 实验证实
当前协议没有被动订阅者角色（审批等请求会扇出给订阅客户端），因此该方向暂缓。
待上游提供 observer/read-only API 或可关联的 Hook/OTel 数据后恢复。0.7.3 使用现有日志的逐响应输出窗口，在完整覆盖时显示生成 TPS 估计，其余轮次显示不可测。主行不混用整轮吞吐。

## 官方参考

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Codex 高级配置与 OTel](https://learn.chatgpt.com/docs/config-file/config-advanced)

## License

[MIT](LICENSE)
