---
name: tps
description: Query the current Codex session's generation TPS estimate, timing coverage, token usage and optional TTFT details.
---

Run `../../scripts/status.mjs --json`, resolving the path relative to this SKILL.md.
The script reads the current session from CODEX_THREAD_ID / CODEX_SESSION_ID. Report the returned
data concisely; if no data exists, ask the user to complete a turn with the plugin Hook loaded.

Only when latest.generation.available and coverageComplete are true, and measurementVersion is 3,
lead with latest.generation.tps labeled “生成 TPS 估计”. Otherwise say “本轮生成 TPS 暂不可测”
and explain latest.generation.exclusionReasons. Never label latest.nonReasoningThroughput,
totalOutputThroughput or a partial response subset as generation TPS.

The formula is sum(output_tokens - 1) / sum(matched client output-window seconds), evaluated per
ordinary response. It excludes first-output waiting, tool execution and identified compaction;
reasoning and non-reasoning usage must have corresponding timing evidence. Client output windows
are estimates, not service-side per-token decoding measurements. Mention short-output noise when
shortOutput is true. If scope or timing is unavailable, preserve that uncertainty.

Report three clearly labeled results: current turn, recentGeneration, and sessionGeneration, plus
output count. For each available historical result include TPS and measuredTurns; otherwise say no
eligible samples. Recent is up to five eligible turns; session is all eligible saved records. Both
require identical recorded model/provider/effort and use summed token intervals / summed generation
time. Identify unknown settings as unknown, and do not call one sample a stable trend. If
latestTurnIncluded is false, say the current turn is excluded. Partial and older measurement versions
are excluded; a historical estimate never replaces unavailable current timing. Saved history is
bounded (200 status files / 2 MiB per session), so session history is not an unlimited lifetime average.
Use generation.measuredResponses / ordinaryResponses and measuredOutputTokenFraction for requested
coverage details. Add TTFT, end-to-end throughput and historical groups only when requested.
End-to-end duration includes waiting and tools; label it explicitly when reporting it. ModelGroups
uses observed model/provider/effort; unknown settings stay unknown. Its generation estimate only
covers eligible measured turns and must not be presented as all-request or current-turn speed.

The automatic Hook runs local scripts and creates no extra model requests. This optional Skill
is a user query in the existing AI conversation; do not claim that the AI reply consumes zero tokens.
Do not send model test requests, enable OTel or run observer probes just to answer a status query.
