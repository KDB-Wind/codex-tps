# Codex TPS 文档

[返回中文首页](../README.zh-CN.md) · [English](../README.md)

| 想了解什么 | 文档 |
| --- | --- |
| 三项速度、公式、计时覆盖和 JSON 语义 | [指标口径与结果解读](metrics.md) |
| Stop 显示、异步回填、稳定快照和隐私 | [工作机制与数据存储](architecture.md) |
| 没有显示、不可测、升级和支持范围 | [安装、支持范围与排障](troubleshooting.md) |
| 终端查询参数与可选 Skill | [本地查询说明](../plugins/codex-tps-plus/docs/local-commands.md) |
| 显式 OTel 捕获与历史协议研究 | [高级实验与历史证据](experiments.md) |

## 开发与版本证据

在仓库根目录执行：

```shell
npm test
npm run release:check
npm run smoke:install
```

安装冒烟使用隔离的临时 `CODEX_HOME`、实际 CLI 和合成 Hook 输入，不发送模型请求。运行它需要 Git、tar 和可用的 Codex CLI；具体 CLI 路径选项见[发布检查清单](../RELEASE-CHECKLIST.md#check-modes-and-promotion)。

- [0.7.4：三项显示与提交前审查](../plugins/codex-tps-plus/reports/0.7.4-candidate.md)
- [0.7.5：部分计时、独立历史与后台命令](../plugins/codex-tps-plus/reports/0.7.5-candidate.md)
- [0.7.3：迟到事件与工具计时](../plugins/codex-tps-plus/reports/0.7.3-candidate.md)
- [0.7.2：查询 Skill 与跨轮快照](../plugins/codex-tps-plus/reports/0.7.2-candidate.md)
- [0.7.1：固定生成口径](../plugins/codex-tps-plus/reports/0.7.1-candidate.md)
- [0.7.0：逐响应计时适配](../plugins/codex-tps-plus/reports/0.7.0-candidate.md)
- [0.6.0 冻结规则（历史）](../PLAN-0.6.0.md)
- [更新记录](../CHANGELOG.md) · [发布检查清单](../RELEASE-CHECKLIST.md) · [安全说明](../SECURITY.md)

历史报告按当时版本描述公式与验证状态；当前生成速度口径以[指标说明](metrics.md)为准，避免把旧整轮吞吐当作当前生成 TPS。
