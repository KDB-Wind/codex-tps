# Changelog

## 0.7.4 - 2026-10-03

- Restore three labeled generation estimates in the automatic Hook: current turn, up to five recent eligible turns, and retained eligible session history. Show actual sample counts and keep output tokens.
- Expose sessionGeneration alongside recentGeneration, with identical model/provider/effort and measurement-version filtering and token-interval/time weighting.
- Preserve the current-turn unavailable reason while showing separately labeled history. Missing samples remain unavailable; older end-to-end metrics never fill generation fields.
- Keep measurement version 3 and existing runtime, optional query skills and no-extra-model-request automatic hooks.
- Reject non-object transcript rows, conflicting tool-return timestamps and duplicate native tool kinds; validate saved generation totals against ordinary-response coverage before including them in current, recent or session speeds.

## 0.7.3 - 2026-10-02

- Resolve output and tool timing after collecting the turn. Match late model items by ID and wrapper tool execution through identified call/return envelopes; reject ambiguous, conflicting or overlapping execution evidence.
- Ignore empty reasoning shells only when authoritative reasoning usage is explicitly zero. Preserve strict complete coverage and tool-first exclusions.
- Recheck generation evidence once after asynchronous completion, preserving original turn order and completed timing. Previously printed Hook lines are not rewritten.
- Explain unavailable timing in the compact Hook. Add human-readable --details / --recent queries and the last five complete same-setting weighted samples in JSON.
- Keep optional query skills and local automatic hooks with no additional model requests. Measurement version 3 keeps older evidence readable without silently mixing it into new comparisons.

## 0.7.2 - 2026-10-02

- Restore optional tps and tps-doctor query skills; automatic Stop hooks still run local scripts without model requests.
- Seed legacy deduplication from the preceding turn's cumulative output snapshot, excluding unchanged rebroadcasts after task start.
- Keep the generation-only primary display and strict timing coverage; query skills explain unavailable evidence without relabeling end-to-end throughput as TPS.

## 0.7.1 - 2026-10-02

- Keep the primary metric exclusively generation TPS estimates; missing timing displays unavailable rather than end-to-end throughput.
- Use per-response inter-token counts (`output_tokens - 1`) and require matching reasoning/non-reasoning timing scopes.
- Mark short-output estimates and reject single-token intervals. Old formula records remain readable but do not become current TPS.
- Remove model-driven query skills and prompt suggestions; provide local status/doctor commands instead. Automatic hooks make no model requests.
- Add a regression check that runs production hooks with networking and child-process access denied.

## 0.7.0 - 2026-10-02

- Prefer response-ID usage records, deduplicate legacy mirrors, retain uncovered legacy usage, and reject conflicting explicit records.
- Separate compaction and unclassified output from ordinary generation accounting.
- Estimate output speed only from complete matched client output windows; exclude tool execution, reject tool-first and ambiguous spans, and expose coverage/exclusion reasons.
- Reduce automatic output to speed and output count, with explicitly labeled end-to-end fallback and no earlier-turn TTFT. Keep verbose and JSON diagnostics available.
- Group session comparisons by observed model, provider and reasoning effort; unknown settings remain separate.
- Retain v1-v6 status compatibility and completion backfill; include the new adapter in stable runtime snapshots.
- Add Codex CLI 0.159.2/0.160.0 installation smoke coverage alongside 0.153.4.

## 0.6.0 - 2026-09-08

- Fail closed when nonzero usage lacks cumulative deduplication evidence instead of merging
  independent requests with equal token counts.
- Preserve completion timing and original turn order across repeated Stop writes, including
  overlapping provisional and backfill records.
- Read completion backfill incrementally after one bounded tail scan, skipping unchanged files
  and recovering from partial UTF-8 writes, truncation, and replacement.
- Label older TTFT as the most recent valid measurement instead of claiming it is the previous turn.
- Separate candidate structure checks from exact-tag release verification and add real CLI installation,
  0.5.0 upgrade, and removed-cache Hook smoke checks to all six CI matrix entries.
- Make non-reasoning output divided by end-to-end turn duration the primary automatic and session
  throughput, while keeping total output and reasoning counts explicit.
- Treat a complete all-reasoning turn as a valid zero non-reasoning rate whose duration remains in
  the weighted session denominator.
- Prefer backfilled `task_complete.duration_ms` over the provisional synchronous Stop wall clock.
- Backfill completion duration independently from TTFT so either valid timing can survive when the
  other is missing or invalid.
- Demote transcript-inferred request intervals to JSON diagnostics and use non-reasoning output for
  that reference instead of presenting it as the default rate.
- Keep v1-v5 status records readable, deriving the new numerator only when their reasoning split is
  complete and valid; otherwise label the total-output fallback explicitly.
- Add regression coverage for invalid reasoning splits, duration-only completion, exact-duration
  replacement, mixed session samples, stable runtime, and strict Hook output.
- Correct second-based timestamp fallbacks in the probe metric model and forward root doctor CLI
  arguments so `npm run doctor -- --json` reaches the doctor's JSON mode as documented.
- Validate all six Windows/macOS/Linux and Node.js 22/24 combinations, including real CLI
  installation and upgrade smoke, before promotion from the trial candidate.

## 0.5.0 - 2026-09-01

- Promote the explicit localhost OTLP receiver to `otel.mjs serve`, with an exclusive directory
  lock, bounded raw-capture retention, and receiver identity metadata.
- Preserve native service/iapi TBT and TTFT histogram window, count, sum, min, and max values.
- Distinguish capture aggregates from strict isolated single-turn candidates; neither is presented
  as current-turn or exact per-request TPS without a validated join identifier.
- Add doctor checks for the live receiver, matching loopback logs/metrics exporters, and concurrent
  conversation contamination.
- Record whether TTFT came from direct async backfill or synchronous previous-turn recovery.
- Order same-core local cachebusters by timestamp and keep an unsuffixed source from replacing an
  active cachebuster in the stable Hook runtime.
- Document controlled single-request, multi-request, concurrent, flush, transport, and subagent
  experiments on Codex CLI 0.149.1.

## 0.4.0 - 2026-08-31

- Add delayed native TTFT backfill from `task_complete.time_to_first_token_ms`.
- Keep the automatic Stop display non-blocking with an official asynchronous Hook.
- Label native OTel TBT conversion as an unattributed session reference, never current-turn TPS.
- Fix direct Hook execution through Windows directory junctions used by installed plugin caches.
- Ignore unread bytes when a live transcript is truncated between file sizing and reading.
- Keep an already-written status usable when retention cleanup encounters a filesystem race.
- Show `tok/s` consistently on the safe whole-turn fallback line.
- Add a bounded, version-independent Hook runtime under `PLUGIN_DATA` so plugin upgrades do not
  leave resumed sessions calling deleted cache paths.
- Let the synchronous Stop handler recover the previous turn's TTFT when the asynchronous backfill
  was not loaded or did not run.
- Publish a standard Git marketplace layout and cross-platform Node.js test matrix.

Earlier development builds were local-only and were not published as GitHub releases.
