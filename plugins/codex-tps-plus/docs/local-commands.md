# 本地查询（不调用模型）

在插件目录执行：

```powershell
node scripts/status.mjs --session-id <会话ID>
node scripts/status.mjs --session-id <会话ID> --json
node scripts/status.mjs --session-id <会话ID> --details
node scripts/status.mjs --session-id <会话ID> --recent
node scripts/status.mjs --session-id <会话ID> --verbose
node scripts/doctor.mjs --json
```

`status.mjs` 也接受当前 Codex 进程提供的 `CODEX_THREAD_ID` / `CODEX_SESSION_ID`，因此在有该环境变量的终端可以省略 `--session-id`。独立终端没有会话环境时需手动指定；脚本不会调用 AI 搜索会话或解释结果。

doctor 的 CLI 子命令最多等待 30 秒；若 `PATH` 中的包装器异常缓慢，可通过 `CODEX_CLI_EXE` 指定实际 Codex 可执行文件，方式与安装冒烟一致。自动 Hook 不运行 CLI 子命令。

0.7.5 默认输出同时展示本轮、近期、会话生成 TPS 估计。完整计时显示“本轮”；部分有效显示“本轮已测”与普通输出 token 覆盖率；没有可信样本才显示“暂不可测”及原因。近期和会话区分“完整 / 已测”并附有效轮数；历史无有效样本时显示“暂无有效样本”，陈旧样本标注“旧样本”。`--json` 包含全部排除原因、token 拆分、整轮吞吐、TTFT 和独立历史；`--verbose` 保留旧整轮吞吐详情。

`--details` 增加响应覆盖率、输出 token 覆盖率、完整和部分历史以及全部排除原因；`--recent` 只查询当前主行所选类型的近期值。
近期比较取本会话最近 5 个完整计时的同记录模型/provider/推理强度轮次，按 token 间隔总数 / 生成时间总数计算，
不是各轮 TPS 的算术平均。`recentGeneration` 提供有效样本数、排除数、捕获时间和 `latestTurnIncluded`；
未知设置不推断。完整版本 3 历史与版本 4 公式相同，继续可用；旧版部分证据不自动升级。近期值不代表当前轮，也不代表全部请求。

部分历史使用 `recentPartialGeneration` / `sessionPartialGeneration`，同样按 token 间隔 / 时间加权，完整与部分样本不混算。
本轮部分可测时主行选择部分历史，否则优先完整历史；没有完整样本时可显示明确标注的部分历史。
`turnsSinceLastSample`、`sampleAgeMs` 和捕获时间描述样本新鲜度；至少 5 个后续同设置轮次或样本达到一小时，会标为旧样本。

`sessionGeneration` 使用相同过滤与加权规则，纳入本会话全部已保存的同设置有效轮次。
其 `sampleLimit=null`、`historyScope=retained-session-records`；每会话现有 200 文件 / 2 MiB 保留上限，
裁剪后按保留记录计算。自动显示中的会话速度由此字段提供，不使用旧 `session.throughput`。

工具计时先收集后关联，调用与返回通过 `call_id` 配对，内部工具项需要明确 ID 或唯一调用边界。
零推理 token 的空占位项不贡献生成时间；有推理用量或可见内容时继续要求有效计时。
完成回填会再核对一次生成证据；详情可能晚于自动 Hook 更新，已打印的行不会变化。

只有 `latest.generation.available` 与 `coverageComplete` 为 true，才使用 `latest.generation.tps` 表示完整计时。
部分计时需 `sampleAvailable=true`、`coverageType=partial`、`measurementVersion=4`，使用 `measuredTps` 并附 `measuredOutputTokenFraction`；`tps` 仍为 null。
公式为已验证响应 `(output_tokens - 1)` 之和除以对应客户端输出窗口秒数之和。推理与非推理输出的用量必须有对应计时证据；工具等待、首字等待及已识别压缩不纳入生成窗口。日志窗口不是服务端逐 token 解码追踪，因此数值始终标记为估计。默认输出数不含已识别压缩；JSON 的 `latest.outputTokens` 保留总用量。

工具先出现、缺失输出项、reasoning 计时缺失或单 token 会排除受影响响应；解析缺口、用量冲突、未确认范围、重叠响应或输出未配齐使全部样本不可用。部分样本不代表整轮，也不能用整轮吞吐填补缺失的生成计时。

0.7.3 保留 `$tps` / `$tps-doctor` 查询 Skill，供用户方便地查询当前会话与诊断。自动 Hook 仍仅在本地执行固定脚本，不创建模型请求、不启动新 turn、不向模型追加统计上下文。Skill 查询的 AI 回复会使用那次对话的 token；直接运行上述本地命令不调用模型。
