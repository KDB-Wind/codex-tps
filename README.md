<div align="center">

# Codex TPS

Generation speed and historical comparisons after each turn.

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/KDB-Wind/codex-tps/actions/workflows/test.yml/badge.svg)](https://github.com/KDB-Wind/codex-tps/actions/workflows/test.yml)

[Quick start](#quick-start) · [Reading the speeds](#reading-the-speeds) · [Query and diagnose](#query-and-diagnose) · [Documentation](#documentation)

</div>

Automatically display three generation TPS estimates in Codex CLI: current turn, recent turns, and session. The automatic Hook runs fixed local scripts without additional model requests. Optional `$tps` and `$tps-doctor` Skills are available for queries and diagnostics.

Hook output is currently in Chinese: 本轮 = current turn, 近期 = recent, 会话 = session, 输出 = output tokens, and 暂不可测 = unavailable.

```text
⚡ 生成 TPS 估计 · 本轮 ≈32.8 tok/s · 近期 ≈35.2 tok/s（5轮） · 会话 ≈34.6 tok/s（12轮） · 输出 2.5k tok
```

This example illustrates the format, not a model speed benchmark. The current-turn estimate requires complete timing evidence; otherwise, it shows “unavailable” with a reason.

## Quick start

Requires Node.js `>= 22.5.0`, with `node` available on the Hook process's `PATH`, and a Codex CLI that supports marketplace plugins and Stop Hooks. See the [tested CLI versions and platforms](docs/troubleshooting.md#要求与验证范围) (Chinese).

```shell
codex plugin marketplace add KDB-Wind/codex-tps --ref main
codex plugin add codex-tps-plus@kdb-wind
codex plugin list --json
```

The repository is named `codex-tps`. The plugin identifier remains `codex-tps-plus@kdb-wind` for compatibility with existing installations.

1. Confirm that `codex-tps-plus@kdb-wind` is `installed` and `enabled`.
2. Open `/hooks`, review and trust the synchronous display command in `hooks/collector.mjs` and the background backfill command in `hooks/backfill.mjs`.
3. Start a new session to load the Hooks and query Skills. Statistics appear automatically after normal conversation turns.

## Reading the speeds

| Speed | Scope |
| --- | --- |
| Current turn (本轮) | Complete client output windows for ordinary responses in the current turn |
| Recent (近期) | Up to 5 latest valid turns with matching settings in this session |
| Session (会话) | All retained valid turns with matching settings in this session |

Historical values match the recorded model, provider, and reasoning effort. They are weighted as total token intervals divided by total generation-window duration; parentheses show the actual number of valid turns. Older measurement methods and unavailable turns are excluded. Unknown settings remain unknown.

The generation estimate includes reasoning and other output with reliable timing. It excludes waiting before the first output in each window, identifiable tool execution, and compaction. Client logs are not server-side token-by-token decoding traces, and windows may still contain pauses, so results are always labeled as estimates.

Historical values can still appear when the current turn lacks sufficient evidence:

```text
⚡ 生成 TPS 估计 · 本轮 暂不可测（工具计时未匹配） · 近期 ≈35.2 tok/s（5轮） · 会话 ≈34.6 tok/s（12轮） · 输出 2.5k tok
```

Short outputs are flagged; a single-token output cannot be measured. TTFT and end-to-end turn throughput are available only in the details. See the [metric guide](docs/metrics.md) (Chinese) for formulas, coverage rules, and field meanings.

## Query and diagnose

Enter `$tps` in Codex to query statistics, or `$tps-doctor` to check installation and reasons for unavailable timing. A Skill's AI reply uses tokens for that conversation; the automatic Hook makes no additional model requests.

You can also run local commands from the repository root:

```shell
node plugins/codex-tps-plus/scripts/status.mjs --session-id <session-id> --details
node plugins/codex-tps-plus/scripts/status.mjs --session-id <session-id> --json
npm run doctor -- --json
```

The session argument can be omitted in a terminal with `CODEX_THREAD_ID` or `CODEX_SESSION_ID`. See [local command options](plugins/codex-tps-plus/docs/local-commands.md) (Chinese).

- **No output:** Check plugin enablement, Hook trust, a new session, and Node.js, then run the doctor. See [troubleshooting](docs/troubleshooting.md#没有显示指标) (Chinese).
- **Unavailable speed:** Inspect `latest.generation.exclusionReasons` in JSON. A successful installation does not guarantee complete timing coverage.
- **All three speeds are identical:** This is expected with one valid sample, or when the recent window covers all valid history.

## Upgrade

```shell
codex plugin marketplace upgrade kdb-wind
codex plugin add codex-tps-plus@kdb-wind
```

Start a new session to load the updated Hook definitions and Skills. Existing sessions can use automatically saved stable Hook snapshots. Changed Hook definitions require another trust review.

## Data and privacy

Normal statistics store only hashed identifiers, numeric metrics, timing coverage, fixed exclusion reasons, and validated model labels. They do not store prompts, response text, tool arguments, or raw IDs. The statistics pipeline does not send session data over the network.

Each session retains at most 200 state files totaling 2 MiB; session speed is calculated from the retained records. Up to 5 production Hook code snapshots are also retained for upgrade recovery. See [architecture and storage](docs/architecture.md) (Chinese).

## Development and validation

Version 0.7.4 passed 141 local tests. All 12 jobs in the [CI run for the corresponding commit](https://github.com/KDB-Wind/codex-tps/actions/runs/37050730180) passed, covering Windows/macOS/Linux × Node.js 22/24 and installation/upgrade checks with CLI 0.153.4, 0.159.2, and 0.160.0.

Installation smoke checks use synthetic Hook input without model requests. These checks do not establish interactive UI testing on all three platforms or benchmark TPS accuracy.

```shell
npm test
npm run release:check
npm run smoke:install
```

## Documentation

Detailed guides are currently available in Chinese:

- [Metrics and interpretation](docs/metrics.md)
- [Architecture and data storage](docs/architecture.md)
- [Installation, support, and troubleshooting](docs/troubleshooting.md)
- [Advanced experiments and historical evidence](docs/experiments.md)
- [Documentation and version evidence](docs/README.md) · [Changelog](CHANGELOG.md) · [Release checks](RELEASE-CHECKLIST.md)

## License

[MIT](LICENSE)
