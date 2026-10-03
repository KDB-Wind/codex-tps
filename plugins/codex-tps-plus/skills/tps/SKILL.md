---
name: tps
description: Query the current Codex session's generation TPS estimate, timing coverage, token usage and optional TTFT details.
---

Run `../../scripts/status.mjs --json`, resolving the path relative to this SKILL.md.
The script reads the current session from CODEX_THREAD_ID / CODEX_SESSION_ID. Report the returned
data concisely; if no data exists, ask the user to complete a turn with the plugin Hook loaded.

When latest.generation.available and coverageComplete are true, report latest.generation.tps
as the complete current-turn estimate. Otherwise, when sampleAvailable is true, coverageType is
partial and measurementVersion is 4, report measuredTps as “本轮已测” with
measuredOutputTokenFraction as output-token coverage. State that it covers only measured responses,
not the entire turn. If neither is available, explain exclusionReasons. Never relabel end-to-end
throughput as generation TPS or infer missing timing by subtracting TTFT or tool time.

The formula is sum(output_tokens - 1) / sum(matched client output-window seconds), evaluated per
ordinary response. It excludes first-output waiting, tool execution and identified compaction;
reasoning and non-reasoning usage must have corresponding timing evidence. Client output windows
are estimates, not service-side per-token decoding measurements. Mention short-output noise when
shortOutput is true. If scope or timing is unavailable, preserve that uncertainty.

Report three results matching the Hook: current turn, recent, and session. For a partial current
turn use recentPartialGeneration and sessionPartialGeneration, labeled “近期已测” and “会话已测”.
Otherwise use recentGeneration and sessionGeneration labeled “近期完整” and “会话完整”; if no
complete history exists, partial history can be shown with its explicit labels. Complete and partial
samples are never mixed. Include TPS and measuredTurns, or say there are no eligible samples. Recent
is up to five eligible turns of that coverage type; session is all eligible saved records. Both
require identical recorded model/provider/effort and use summed token intervals / summed generation
time. Identify unknown settings as unknown, and do not call one sample a stable trend. If
latestTurnIncluded is false, say the current turn is excluded from that history. Mark stale history
as old samples; JSON provides turnsSinceLastSample, sampleAgeMs and sample timestamps. A historical
estimate never replaces unavailable current timing. Complete evidence version 3 remains compatible
with version 4's unchanged formula; saved version-3 partials are not promoted. Saved history is
bounded (200 status files / 2 MiB per session), so session history is not an unlimited lifetime average.
Use generation.measuredResponses / ordinaryResponses and measuredOutputTokenFraction for requested
coverage details. Hook output count excludes identified compaction; latest.outputTokens is total
usage including compaction. Add TTFT, end-to-end throughput and historical groups only when requested.
End-to-end duration includes waiting and tools; label it explicitly when reporting it. ModelGroups
uses observed model/provider/effort; unknown settings stay unknown. Its generation estimate only
covers eligible measured turns and must not be presented as all-request or current-turn speed.

The automatic Hook runs local scripts and creates no extra model requests. This optional Skill
is a user query in the existing AI conversation; do not claim that the AI reply consumes zero tokens.
Do not send model test requests, enable OTel or run observer probes just to answer a status query.
