# 高级实验与历史证据

[返回中文首页](../README.zh-CN.md) · [文档索引](README.md)

本文适合显式选择采集原生 timing 或研究协议的开发者。正常使用只需 Stop Hook；以下接收器、探针与 observer 均不会自动启用。

## 可选 OTel 查询与捕获

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

## 开发与验证命令

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
不会创建或禁止标签；正式发布步骤见 [发布检查清单](../RELEASE-CHECKLIST.md)。

仓库保留第一阶段的脱敏 transcript 探针，并将 localhost OTLP 接收器作为显式实验子命令。
它们不属于生产 Hook 注册项，也不会自动启用。

OTLP 原始 `.bin` 可能包含 prompt、工具或其他敏感属性。接收器只监听 `127.0.0.1`，但
这不等于内容已脱敏；实验结束后应删除准确的捕获目录，绝不能提交 `artifacts/otel/`。
结构化检查器只输出允许列出的结构、名称和数字，它不能证明原始 body 安全。

已验证样本中的原生 OTel TBT/TTFT 为异步批量 histogram，且没有可与当前 Stop 稳定关联的
request/turn ID，因此运行时不会把 `1000 / TBT_ms` 冒充当前轮 TPS。日志中同时出现 SSE
和 WebSocket 命名信号，而 0.149.1 的相关切换 feature 已移除，插件不会据此伪造传输类型。

详细证据见 [第一阶段验证报告](../plugins/codex-tps-plus/reports/validation.md)、
[第二阶段实现说明](../plugins/codex-tps-plus/reports/phase-two.md)、
[第三阶段请求区间吞吐说明](../plugins/codex-tps-plus/reports/phase-three.md) 和
[第四阶段延迟 TTFT 说明](../plugins/codex-tps-plus/reports/phase-four.md) 和
[第五阶段 OTel 实验报告](../plugins/codex-tps-plus/reports/phase-five.md)。0.6.0 的审计证据、
冻结公式和兼容规则见 [准确性修订冻结说明](../PLAN-0.6.0.md)。0.7.0 的实现、验证范围与剩余限制见 [候选版验证说明](../plugins/codex-tps-plus/reports/0.7.0-candidate.md)。
0.7.1 的固定主口径与本地统计约束见 [0.7.1 验证说明](../plugins/codex-tps-plus/reports/0.7.1-candidate.md)。
Skill 恢复与跨轮快照修复见 [0.7.2 验证说明](../plugins/codex-tps-plus/reports/0.7.2-candidate.md)；迟到事件修复见 [0.7.3 验证说明](../plugins/codex-tps-plus/reports/0.7.3-candidate.md)；三项自动显示见 [0.7.4 验证说明](../plugins/codex-tps-plus/reports/0.7.4-candidate.md)。

## 后续方向

实时吞吐/TTFT/turn 级 usage 依赖 App Server 的只读会话事件流；phase-six 实验证实
当前协议没有被动订阅者角色（审批等请求会扇出给订阅客户端），因此该方向暂缓。
待上游提供 observer/read-only API 或可关联的 Hook/OTel 数据后恢复。当前版本使用现有日志的逐响应输出窗口；完整覆盖显示本轮估计，部分计时显示已测样本及覆盖率，无可信样本时不可测。主行不混用整轮吞吐。

## 官方参考

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Codex 高级配置与 OTel](https://learn.chatgpt.com/docs/config-file/config-advanced)
