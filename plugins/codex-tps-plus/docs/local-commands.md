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

0.7.4 默认输出同时展示本轮、近期、会话生成 TPS 估计，近期与会话附有效轮数；本轮计时不足时保留“暂不可测”及原因，历史无有效样本时明确显示“暂无有效样本”。`--json` 包含 `latest.generation.exclusionReasons`、token 拆分、整轮吞吐、TTFT 和分组历史；`--verbose` 保留旧整轮吞吐详情。

`--details` 增加响应覆盖率、输出 token 覆盖率与近期同设置加权值；`--recent` 只查询近期值。
近期比较取本会话最近 5 个完整计时的同记录模型/provider/推理强度轮次，按 token 间隔总数 / 生成时间总数计算，
不是各轮 TPS 的算术平均。`recentGeneration` 提供有效样本数、排除数、捕获时间和 `latestTurnIncluded`；
未知设置不推断，旧方法不混入。近期值不代表当前轮，也不代表全部请求。

`sessionGeneration` 使用相同过滤与加权规则，纳入本会话全部已保存的同设置有效轮次。
其 `sampleLimit=null`、`historyScope=retained-session-records`；每会话现有 200 文件 / 2 MiB 保留上限，
裁剪后按保留记录计算。自动显示中的会话速度由此字段提供，不使用旧 `session.throughput`。

工具计时先收集后关联，调用与返回通过 `call_id` 配对，内部工具项需要明确 ID 或唯一调用边界。
零推理 token 的空占位项不贡献生成时间；有推理用量或可见内容时继续要求有效计时。
完成回填会再核对一次生成证据；详情可能晚于自动 Hook 更新，已打印的行不会变化。

只有 `latest.generation.available` 与 `coverageComplete` 为 true，且 `measurementVersion` 为 3，才使用 `latest.generation.tps`。公式为各响应 `(output_tokens - 1)` 之和除以对应客户端输出窗口秒数之和。推理与非推理输出的用量必须有对应计时证据；工具执行、首字等待及已识别压缩不纳入生成窗口。日志窗口不是服务端逐 token 解码追踪，因此数值始终标记为估计。

未确认范围、工具先出现、缺失输出项、reasoning 计时缺失、未知 reasoning 用量、单 token 输出或旧统计公式都不产生主速度。禁止用整轮吞吐或部分响应的速度替换它。

0.7.3 保留 `$tps` / `$tps-doctor` 查询 Skill，供用户方便地查询当前会话与诊断。自动 Hook 仍仅在本地执行固定脚本，不创建模型请求、不启动新 turn、不向模型追加统计上下文。Skill 查询的 AI 回复会使用那次对话的 token；直接运行上述本地命令不调用模型。
