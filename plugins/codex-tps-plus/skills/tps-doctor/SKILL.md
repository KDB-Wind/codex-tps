---
name: tps-doctor
description: Diagnose Codex TPS installation, unavailable generation timing, usage coverage and delayed completion backfill.
---

Run `../../scripts/doctor.mjs --json` and `../../scripts/status.mjs --json`, resolving paths relative
to this SKILL.md. Report prerequisite failures and latest.generation.exclusionReasons, not only
whether the numeric TPS field is null. Automatic Hook statistics use local scripts and no model requests;
this optional AI query is ordinary conversation usage.

Common reasons: tool_argument_timing_unconfirmed means a tool's execution cannot be uniquely joined
to argument output (missing/conflicting call-return identity or timing); tool_execution_overlaps_output
means execution intersects a candidate generation window. These can be parser association failures,
not proof that the CLI omitted timestamps. response_scope_unknown means a usage boundary has no matched output evidence;
reasoning_timing_missing means counted reasoning lacks corresponding timing. Old generation methods
are preserved as historical data and are not automatically converted into current TPS.

When a Hook transcript is supplied, `../../scripts/analyze-transcript.mjs <transcript.jsonl>` provides
a redacted structural summary. Do not display prompts, tool arguments or raw identifiers. An unchanged
legacy cumulative output snapshot from before task_started is not a new response; do not suggest
loosening coverage rules to obtain a higher number.

Use doctor.timing and status.latest.generation to distinguish installation failures from measurement
coverage. Report response coverage and output-token coverage when useful. Completion backfill rereads
generation evidence once; saved queries can improve after the Hook, but an already printed Hook line
does not update. recentGeneration and sessionGeneration are comparisons of eligible saved same-setting
turns, never replacements for the current turn. The Hook labels all three speeds and measured sample
counts; missing historical samples do not indicate a failed installation.

Completion duration and TTFT backfill independently. They describe turn timing and must not be used
to fabricate generation speed by subtracting one TTFT from full turn duration. Missing generation
evidence stays unavailable; end-to-end throughput is a separately named diagnostic.

Do not send model test requests, enable OTel or start the observer unless that experiment is requested.
Native TBT captures lacking a validated turn/request join remain unattributed references.
