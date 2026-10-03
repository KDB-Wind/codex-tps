# Release checklist

## 0.7.5 validation record — 2026-10-03

- Package and manifest versions are `0.7.5`; 151 local tests pass.
- CLI `0.159.2` passes isolated installation/upgrade smoke, including partial Hook output,
  separate complete/partial history, and the existing completion and cache-recovery checks.
- Network APIs, network imports, and child-process imports are denied during complete and
  partial Hook regression checks; no model requests are sent.
- A redacted 15,684-token real-turn replay matches the original logs. Measured response
  coverage improves from 7/20 to 14/20; output-token coverage improves from 32.6% to 74.9%.
- This is a main-branch candidate. The configured cross-platform/CLI matrix must pass for
  each pushed commit; there is no claimed `v0.7.5` tag or published GitHub Release.
- Details and limits: [candidate evidence](plugins/codex-tps-plus/reports/0.7.5-candidate.md).

### Current product contract

- Automatic Stop hooks execute local scripts without additional model requests.
- Complete timing displays current-turn TPS; validated partial timing displays a measured
  subset with token coverage. Only absence of a trustworthy sample displays unavailable.
- Complete and partial histories remain separate and explicitly labeled. Recent uses up
  to five same-setting samples of the selected type; session uses all retained eligible samples.
- Evidence version 4 keeps `sum(output_tokens - 1) / sum(output_window_seconds)`. Complete
  version-3 history remains compatible; stored older partial evidence is not promoted.
- `available`, `coverageComplete`, and `tps` retain complete-turn semantics; partial values
  use `sampleAvailable`, `measuredTps`, and `coverageType`. No end-to-end fallback is used.
- FileChange is supported; detached commands require a unique identified start envelope.
  Parse gaps, conflicting usage, ambiguous scope and overlapping responses remain excluded.
- Old history is flagged after five subsequent same-setting turns or one hour since capture.
- Default output count excludes identified compaction; JSON preserves total usage and scopes.
- TTFT and end-to-end throughput remain separate details. Optional Skill replies use the
  existing conversation's tokens; stable recovery, backfill and bounded privacy remain intact.

## 0.7.4 validation record — 2026-10-03

- The repository package, plugin package, and manifest identify version `0.7.4`.
- Local validation passes 141 tests and the candidate structure check. CLI `0.153.4`,
  `0.159.2`, and `0.160.0` each pass isolated installation/upgrade smoke without model requests.
- Commit `8fe7de8` passes all 12 Windows/macOS/Linux CI jobs
  ([run 37050730180](https://github.com/KDB-Wind/codex-tps/actions/runs/37050730180)).
  Later commits must pass their own CI before their changes are described as validated.
- This record covers the main-branch candidate. It does not establish a `v0.7.4` tag or
  published GitHub Release.

### Historical 0.7.4 product contract

- Automatic Stop hooks execute local scripts without additional model requests.
- The default line labels current, recent, and retained-session generation TPS estimates.
  Generation requires complete matched response timing; unavailable evidence stays unavailable.
- Generation uses measurement version 3: `sum(output_tokens - 1) / sum(output_window_seconds)`.
  Reasoning is already included in output tokens; compaction and tool execution are excluded.
  Client windows remain estimates, not server token-level decoding measurements.
- Recent comparisons use up to five eligible same-setting turns; session comparisons use all
  retained eligible same-setting turns. Both divide total token intervals by total window time.
- TTFT and end-to-end throughput are separately labeled details. Neither replaces generation TPS.
- Optional query skills remain available; their AI replies use the querying conversation's tokens.
- Completion backfill, stable runtime recovery, bounded redacted storage, and opt-in experiments
  retain their existing constraints. See [metric definitions](docs/metrics.md) and
  [runtime and storage](docs/architecture.md).

## 0.6.0 release approval — 2026-09-08

- [x] The repository, plugin package, and plugin manifest identify version `0.6.0`.
- [x] The accuracy contract is frozen in `PLAN-0.6.0.md`.
- [x] Local unit, Hook contract, privacy, retention, doctor, and marketplace release checks pass.
- [x] The user authorized promotion to main, the release tag, and GitHub Release after the local trial.
- [x] Automated installation smoke uses a disposable CODEX_HOME, real Codex CLI 0.153.4, and synthetic Hook inputs.
- [x] Local Windows install, 0.5.0 upgrade, completion backfill, repeated Stop, and removed-cache recovery pass.
- [x] Candidate `cb294b6` passes the Windows/macOS/Linux matrix on Node.js 22 and 24
      ([run 34089731796](https://github.com/KDB-Wind/codex-tps/actions/runs/34089731796));
      rerun this gate for any later code changes.
- [x] The fixed production files are installed locally with a distinct cachebuster, content checked,
      and the stable runtime is activated; doctor reports zero failed checks.
- [x] The user supplied a real new-session Hook line with non-reasoning throughput and the corrected TTFT label.
- Resumed-session recovery is covered by automated removed-cache smoke; a separate interactive resumed-session
  trial and macOS/Linux TUI trial have not been independently recorded. These evidence limits remain explicit.

## Check modes and promotion

`npm run release:check` (or `-- --candidate`) validates package structure, consistent unsuffixed
versions, Hook definitions, and tracked-file hygiene. It does not require or forbid a local release
tag, so fetching historical tags cannot break candidate or main CI. It never publishes anything.

`npm run release:verify` performs the same checks and additionally requires a clean checkout and
`v<package.version>` pointing to HEAD. In tag CI, the triggering tag must match the package version.
The workflow fetches full history and runs this mode for tag pushes. Regression tests exercise missing
tags, dirty trees, mismatched tags, and tags pointing to another commit.

After trial approval: merge the validated changes to main, rerun the matrix, tag the intended commit,
and require the tag matrix (including `release:verify`) to pass before publishing a GitHub Release.
No automatic release publication is configured.

`npm run smoke:install` requires Git, tar, and a supported globally installed `@openai/codex`
(or `CODEX_CLI_JS` pointing to its `bin/codex.js`, or `CODEX_CLI_EXE` pointing to the native executable).
The current workflow checks CLI `0.153.4`, `0.159.2`, and `0.160.0`. It installs 0.6.0 from the local tagged archive,
upgrades through a configured local marketplace to the working candidate, checks the installed cache,
and exercises the actual shell Hook commands. It does not send a model request or replace interactive
TUI validation. The default test workflow runs this smoke on every matrix entry.

## Historical 0.6.0 product contract

These checked items describe the released 0.6.0 behavior. The current generation-only
display uses the 0.7.5 contract above; these historical end-to-end formulas do not define it.

- [x] The automatic line leads with non-reasoning output divided by end-to-end turn duration.
- [x] `reasoning_output_tokens` is validated as a subset, subtracted once from the primary numerator,
      and retained as a separate display field.
- [x] A valid `task_complete.duration_ms` replaces the provisional Stop wall-clock denominator after
      backfill; missing TTFT does not block that correction.
- [x] Session throughput is token-and-duration weighted and does not mix records whose reasoning
      breakdown is unavailable into the non-reasoning average.
- [x] Missing or invalid reasoning breakdown degrades to an explicitly named total-output fallback.
- [x] Transcript-inferred request intervals remain available only as a diagnostic reference and are
      not presented as the default rate or pure-generation TPS.
- [x] TTFT comes from Codex `task_complete.time_to_first_token_ms` and is backfilled asynchronously.
- [x] Unattributed OTel TBT is labeled as a capture reference or isolated single-turn candidate,
      always marked unjoined to the current turn.
- [x] Native OTel capture remains explicit opt-in; production Hooks never start the receiver or
      modify the user's exporter configuration.
- [x] Hook failures degrade without steering or extending the model turn.

## Historical 0.6.0 runtime evidence

- [x] The synchronous handler emits strict JSON and persists only redacted numeric status.
- [x] The background handler independently backfills available TTFT and completion duration.
- [x] A later synchronous Stop recovers the previous turn's timing if asynchronous backfill was missed.
- [x] Installed-cache execution through a Windows directory junction is covered by regression tests.
- [x] Removed version caches degrade to strict empty JSON instead of a failed Hook.
- [x] Stable runtime snapshots remain bounded and cannot be rolled back by an older plugin root.
- [x] The local receiver is loopback-only, directory-exclusive, atomically written, and bounded by
      body, payload-count, and total-byte limits.
- [x] The phase-six observer remains capture-only for untested schemas/daemons and does not gain a
      passive App Server role.

## Historical 0.6.0 distribution and safety

- [x] The repository contains `.agents/plugins/marketplace.json`.
- [x] The plugin is located at `plugins/codex-tps-plus` and has a valid manifest.
- [x] Manifest, root package, plugin package, changelog, and release check use version `0.6.0`.
- [x] The candidate manifest contains no local cachebuster suffix.
- [x] No raw transcript, OTLP body, credential, review note, or local absolute path is tracked.
- [x] OTel reports expose only allowlisted structure and numbers; raw `.bin` files remain explicitly
      documented as potentially sensitive.
- [x] MIT license notices and security reporting guidance remain present.

## Published v0.5.0 evidence (historical)

- The reviewed `v0.5.0` tag points to `bea3497e5022eb018ee63fa338cd7e7b3ec8ede6`.
- The [tag matrix](https://github.com/KDB-Wind/codex-tps/actions/runs/33458712669) and
  [initial main matrix](https://github.com/KDB-Wind/codex-tps/actions/runs/33458712814) passed
  on Windows, macOS, and Linux with Node.js 22 and 24.
- The [v0.5.0 GitHub Release](https://github.com/KDB-Wind/codex-tps/releases/tag/v0.5.0)
  is public and is neither a draft nor a prerelease.
- A clean public-marketplace smoke test installed version 0.5.0, reported it enabled, validated
  the installed plugin structure, and returned strict `{}` JSON from the installed Stop collector.
