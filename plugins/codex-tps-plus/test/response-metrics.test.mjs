import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { analyzeResponseMetrics } from "../scripts/response-metrics.mjs";
import { waitAndBackfill } from "../hooks/backfill.mjs";
import { backfillTurnCompletion, extractStopMetric, recordStopMetric, readSessionStatus, formatStatusLine, formatStatusDetails, formatRecentGeneration, summarizeStatusRecords } from "../scripts/status-core.mjs";

const BASE = Date.parse("2026-10-02T00:00:00Z");
const row = (type, payload, ms = 0) => ({ timestamp: new Date(BASE + ms).toISOString(), type, payload });
const event = (payload, ms = 0) => row("event_msg", payload, ms);
const start = () => event({ type: "task_started", turn_id: "turn" });
const item = (id = "item", from = 1000, to = 2000, kind = "AgentMessage") => event({
  type: "item_completed", thread_id: "session", turn_id: "turn",
  item: { type: kind, id, content: "PRIVATE BODY" }, started_at_ms: BASE + from, completed_at_ms: BASE + to,
}, to);
const output = (id = "item", from = 1000, to = 2000) => [
  item(`${id}-reasoning`, from, to, "Reasoning"), item(id, from, to),
];
const used = (id = "response", output = 100, reasoning = 20, ms = 2200, extra = {}) => row("token_usage_record", {
  thread_id: "session", turn_id: "turn", response_id: id,
  usage: { output_tokens: output, reasoning_output_tokens: reasoning },
  turn_token_usage: { output_tokens: 999999 }, thread_token_usage: { output_tokens: 999999 }, ...extra,
}, ms);
const legacy = (output = 100, reasoning = 20, total = 100, ms = 2300) => event({ type: "token_count",
  info: { last_token_usage: { output_tokens: output, reasoning_output_tokens: reasoning },
    ...(total === undefined ? {} : { total_token_usage: { output_tokens: total } }) } }, ms);
const text = rows => rows.map(x => JSON.stringify(x)).join("\n") + "\n";
const analyze = rows => analyzeResponseMetrics(text(rows), "turn", { sessionId: "session" });

test("explicit usage and legacy mirrors count once, with exact identity rather than equal token counts", () => {
  const result = analyze([start(), ...output(), used(), legacy(), used(), legacy(),
    ...output("next", 3000, 5000), used("next-response", 100, 20, 5200), legacy(100, 20, 200, 5300)]);
  assert.equal(result.available, true);
  assert.equal(result.outputTokens, 200);
  assert.equal(result.reasoningTokens, 40);
  assert.equal(result.responses, 2);
  assert.equal(result.duplicateResponses, 1);
  assert.equal(result.generation.available, true);
  assert.equal(result.generation.intervalOutputTokens, 198);
  assert.equal(result.generation.tps, 198 / 3);
});

test("a legacy boundary arriving before its explicit record is replaced rather than added", () => {
  const result = analyze([start(), ...output(), legacy(), used("response", 100, 20, 2400)]);
  assert.equal(result.outputTokens, 100);
  assert.equal(result.responses, 1);
  assert.equal(result.usageSource, "explicit_response_usage");
  assert.equal(result.generation.tps, 99);
});

test("uncovered legacy response supplements usage but disables complete output-speed coverage", () => {
  const result = analyze([start(), item(), used(), legacy(), item("legacy", 3000, 4000), legacy(50, 10, 150, 4200)]);
  assert.equal(result.outputTokens, 150);
  assert.equal(result.usageSource, "explicit_with_legacy_fallback");
  assert.equal(result.generation.available, false);
  assert.equal(result.generation.exclusionReasons.legacy_response_identity_missing, 1);
});

test("a previous-turn legacy snapshot rebroadcast after task start is not new usage or incomplete coverage", () => {
  const result = analyze([legacy(193, 0, 85228, -1000), start(), legacy(193, 0, 85228, 500),
    ...output(), used("response", 1307, 1034), legacy(1307, 1034, 86535)]);
  assert.equal(result.outputTokens, 1307);
  assert.equal(result.scopes.unclassified.responses, 0);
  assert.equal(result.responses, 1);
  assert.equal(result.generation.available, true);
  assert.equal(result.generation.tps, 1306);
});

test("legacy-only extraction uses the previous cumulative baseline without merging equal new response counts", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tps-baseline-"));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const transcript = path.join(directory, "synthetic.jsonl");
  fs.writeFileSync(transcript, text([legacy(100, 20, 100, -1000), start(), legacy(100, 20, 100, 500),
    ...output(), legacy(100, 20, 200)]));
  const metric = extractStopMetric(transcript, "turn", { nowMs: BASE + 5000, sessionId: "session" });
  assert.equal(metric.available, true);
  assert.equal(metric.outputTokens, 100);
  assert.equal(metric.reasoningTokens, 20);
});

test("legacy mirrors with missing reasoning use the authoritative explicit split in either order", () => {
  const missing = legacy();
  delete missing.payload.info.last_token_usage.reasoning_output_tokens;
  for (const boundaries of [[used(), missing], [missing, used("response", 100, 20, 2400)]]) {
    const result = analyze([start(), ...output(), ...boundaries]);
    assert.equal(result.outputTokens, 100);
    assert.equal(result.reasoningTokens, 20);
    assert.equal(result.generation.tps, 99);
  }
});

test("compaction output is accounted separately and never added to normal generation TPS", () => {
  const result = analyze([start(), ...output(), used(), legacy(), used("compact", 3319, 0, 2500),
    row("compacted", { message: "PRIVATE SUMMARY" }, 2600), legacy(0, 0, 100, 2700),
    ...output("next", 4000, 5000), used("next-response", 200, 50, 5200), legacy(200, 50, 300, 5300)]);
  assert.equal(result.outputTokens, 3619);
  assert.equal(result.scopes.compaction.outputTokens, 3319);
  assert.equal(result.scopes.ordinary.outputTokens, 300);
  assert.equal(result.generation.outputTokens, 300);
  assert.equal(result.generation.tps, 149);
  assert.equal(result.generation.available, true);
});

test("foreign threads, foreign turns and fork history before start cannot contribute usage", () => {
  const result = analyze([item(), used("copied"), start(),
    used("foreign-thread", 900, 0, 2000, { thread_id: "other" }),
    event({ type: "task_complete", thread_id: "other", turn_id: "turn" }, 2000),
    used("foreign-turn", 900, 0, 2000, { turn_id: "other" }), item(), used()]);
  assert.equal(result.outputTokens, 100);
  assert.equal(result.responses, 1);
});

test("raw model output without matching timed items cannot omit output time", () => {
  for (const generated of [
    [row("response_item", { type: "reasoning" }, 1500), item()],
    [row("response_item", { type: "message", role: "assistant" }, 1500),
      row("response_item", { type: "message", role: "assistant" }, 1800), item()],
    [row("response_item", { type: "message", role: "assistant" }, 500), item()],
  ]) {
    const result = analyze([start(), ...generated, used()]);
    assert.equal(result.generation.available, false);
    assert.equal(result.generation.exclusionReasons.unmatched_model_output, 1);
    assert.equal(result.outputTokens, 100);
  }
  const matched = analyze([start(), row("response_item", { type: "message", role: "assistant" }, 2000), item(), used("response", 100, 0)]);
  assert.equal(matched.generation.available, true);
});

test("conflicting duplicate response usage fails closed", () => {
  const result = analyze([start(), item(), used(), used("response", 101)]);
  assert.equal(result.available, false);
  assert.equal(result.reason, "conflicting_response_usage");
});

test("explicit record with incomplete identity is not silently replaced with legacy counts", () => {
  const result = analyze([start(), item(), used("", 100), legacy()]);
  assert.equal(result.available, false);
  assert.equal(result.reason, "explicit_usage_identity_missing");
});

test("zero-duration, missing timing and tool-first responses retain usage without fabricated speed", () => {
  const scenarios = [
    [item("zero", 1000, 1000)],
    [event({ type: "item_completed", thread_id: "session", turn_id: "turn", item: { type: "AgentMessage", id: "missing" } }, 2000)],
    [row("response_item", { type: "function_call", id: "tool", arguments: "PRIVATE ARGS" }, 1000), item()],
  ];
  for (const generated of scenarios) {
    const result = analyze([start(), ...generated, used()]);
    assert.equal(result.available, true);
    assert.equal(result.outputTokens, 100);
    assert.equal(result.generation.available, false);
    assert.equal(result.generation.tps, null);
  }
});

test("matched tool arguments use generation completion, excluding subsequent tool execution and delayed usage", () => {
  const result = analyze([start(), item("reasoning", 1000, 2000, "Reasoning"),
    row("response_item", { type: "function_call", id: "call" }, 3000),
    event({ type: "item_completed", item: { type: "CommandExecution", id: "call" }, started_at_ms: BASE + 3100, completed_at_ms: BASE + 9000 }, 9000),
    used("response", 400, 100, 10000)]);
  assert.equal(result.generation.durationMs, 2000);
  assert.equal(result.generation.tps, 199.5);
});

test("overlapping model items within a response use their complete span once; overlapping responses are rejected", () => {
  const result = analyze([start(), item("r", 1000, 3000, "Reasoning"), item("a", 2000, 4000), used("response", 300, 100, 4200)]);
  assert.equal(result.generation.durationMs, 3000);
  assert.equal(result.generation.tps, 299 / 3);
  const overlap = analyze([start(), ...output(), used(), item("next", 1500, 4000), used("next-response", 200, 0, 4200)]);
  assert.equal(overlap.generation.available, false);
  assert.equal(overlap.generation.exclusionReasons.overlapping_response_windows, 1);
});

test("unmatched output, parse gaps and interrupted turns cannot become completed speed measurements", () => {
  const pending = analyze([start(), item(), used(), item("unfinished", 2500, 3000)]);
  assert.equal(pending.generation.available, false);
  const interrupted = analyze([start(), item(), used(), event({ type: "turn_aborted", turn_id: "turn" }, 3000)]);
  assert.equal(interrupted.available, false);
  assert.equal(interrupted.reason, "turn_interrupted");
  const corrupt = analyzeResponseMetrics(text([start(), item()]) + "{partial\n" + text([used()]), "turn", { sessionId: "session" });
  assert.equal(corrupt.generation.available, false);
});

test("short outputs are annotated rather than discarded; zero reasoning is valid", () => {
  const result = analyze([start(), item(), used("response", 5, 0)]);
  assert.equal(result.generation.available, true);
  assert.equal(result.generation.tps, 4);
  assert.equal(result.generation.shortOutput, true);
});

test("modern extraction persists safe summaries, preserves timing and shows three labeled speeds", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tps-modern-"));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const transcript = path.join(directory, "synthetic.jsonl");
  fs.writeFileSync(transcript, text([start(), row("turn_context", { model: "gpt-test", effort: "high", prompt: "PRIVATE PROMPT" }, 50), ...output(), used()]));
  const metric = extractStopMetric(transcript, "turn", { nowMs: BASE + 5000, sessionId: "session" });
  assert.equal(metric.outputTokens, 100);
  assert.equal(metric.generation.tps, 99);
  recordStopMetric({ dataDir: directory, sessionId: "session", turnId: "turn", metric });
  const status = readSessionStatus({ dataDir: directory, sessionId: "session" });
  assert.equal(status.latest.context.model, "gpt-test");
  assert.equal(formatStatusLine(status), "⚡ 生成 TPS 估计 · 本轮 ≈99.0 tok/s（短输出） · 近期完整 ≈99.0 tok/s（1轮） · 会话完整 ≈99.0 tok/s（1轮） · 输出 100 tok");
  const files = fs.readdirSync(path.join(directory, "status"), { recursive: true }).filter(x => x.endsWith(".json"));
  const saved = files.map(x => fs.readFileSync(path.join(directory, "status", x), "utf8")).join("");
  assert.doesNotMatch(saved, /PRIVATE|response_id|thread_id|synthetic\.jsonl|"arguments"/);
  assert.equal(status.latest.nonReasoningThroughput, 16);
  backfillTurnCompletion({ dataDir: directory, sessionId: "session", turnId: "turn",
    completion: { available: true, completedDurationMs: 4000, ttftMs: 900 } });
  const corrected = readSessionStatus({ dataDir: directory, sessionId: "session" });
  assert.equal(corrected.latest.generation.tps, 99);
  assert.equal(corrected.latest.nonReasoningThroughput, 20);
  assert.equal(corrected.latest.ttftMs, 900);
});

test("invalid persisted timing falls back with an explicit reason instead of displaying a partial estimate", () => {
  const g = analyze([start(), ...output(), used()]).generation;
  const status = summarizeStatusRecords([{ outputTokens: 100, reasoningTokens: 20, durationMs: 500,
    generation: g }]);
  assert.equal(status.latest.generation.available, false);
  assert.equal(status.latest.generation.tps, null);
  assert.equal(status.latest.generation.exclusionReasons.invalid_saved_generation_evidence, 1);
  assert.match(formatStatusLine(status), /本轮 暂不可测/);
});

test("default history excludes end-to-end averages while verbose details preserve them", () => {
  const status = summarizeStatusRecords([{ outputTokens: 100, reasoningTokens: 20, durationMs: 5000, ttftMs: 1000 },
    { outputTokens: 200, reasoningTokens: 40, durationMs: 10000 }]);
  assert.equal(formatStatusLine(status), "⚡ 生成 TPS 估计 · 本轮 暂不可测 · 近期完整 暂无有效样本 · 会话完整 暂无有效样本 · 输出 200 tok");
  assert.equal(status.displayMetric, "generation_tps_unavailable");
  assert.doesNotMatch(formatStatusLine(status), /TTFT|会话 [\d≈]|推理 40/);
  assert.match(formatStatusLine(status, { verbose: true }), /最近有效 TTFT/);
});

test("output and timing scopes must cover both reasoning and non-reasoning tokens", () => {
  const hidden = analyze([start(), item(), used()]);
  assert.equal(hidden.generation.exclusionReasons.reasoning_timing_missing, 1);
  const noAnswer = analyze([start(), item("r", 1000, 2000, "Reasoning"), used()]);
  assert.equal(noAnswer.generation.exclusionReasons.non_reasoning_timing_missing, 1);
  const unknown = used(); delete unknown.payload.usage.reasoning_output_tokens;
  const result = analyze([start(), ...output(), unknown]);
  assert.equal(result.generation.exclusionReasons.reasoning_usage_unknown, 1);
  for (const r of [hidden, noAnswer, result]) assert.equal(r.generation.tps, null);
});

test("a single token has no inter-token interval and must not display a zero or fabricated TPS", () => {
  const result = analyze([start(), item(), used("response", 1, 0)]);
  assert.equal(result.generation.available, false);
  assert.equal(result.generation.exclusionReasons.insufficient_output_tokens, 1);
});

test("old generation formulas remain readable as details without silently becoming current TPS", () => {
  const g = analyze([start(), ...output(), used()]).generation;
  delete g.measurementVersion; delete g.intervalOutputTokens;
  const status = summarizeStatusRecords([{ outputTokens: 100, durationMs: 5000, generation: g }]);
  assert.equal(status.latest.generation.available, false);
  assert.equal(status.modelGroups[0].outputSpeedEstimate, null);
  assert.match(formatStatusLine(status), /暂不可测（计时证据未通过校验）/);
});

const call = (id = "outer", at = 3000) => row("response_item", { type: "custom_tool_call", id: `raw-${id}`, call_id: id }, at);
const returned = (id = "outer", at = 9000) => row("response_item", { type: "custom_tool_call_output", call_id: id }, at);
const execution = (id = "native", from = 3100, to = 8000, kind = "CommandExecution") => event({ type: "item_completed",
  item: { type: kind, id }, started_at_ms: BASE + from, completed_at_ms: BASE + to }, to);

test("non-object JSON rows preserve usage but invalidate generation coverage without crashing", () => {
  for (const invalid of [null, [], 42, "invalid"]) {
    const result = analyze([start(), ...output(), invalid, used()]);
    assert.equal(result.outputTokens, 100);
    assert.equal(result.generation.available, false);
    assert.equal(result.generation.exclusionReasons.transcript_parse_error, 1);
  }
});

test("direct tool identity cannot override conflicting or invalid return timestamps", () => {
  const body = [start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050), execution("outer")];
  const invalidReturn = returned(); invalidReturn.timestamp = "invalid";
  for (const rows of [[returned(), returned("outer", 9200)], [invalidReturn]]) {
    const result = analyze([...body, ...rows]);
    assert.equal(result.generation.available, false);
    assert.equal(result.generation.exclusionReasons.tool_argument_timing_unconfirmed, 1);
  }
  assert.equal(analyze(body).generation.available, true);
});

test("duplicate native tool identity with conflicting kinds is rejected in either order", () => {
  for (const kinds of [["CommandExecution", "FutureToolType"], ["FutureToolType", "CommandExecution"], ["CommandExecution", "Extension"]]) {
    const result = analyze([start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050),
      ...kinds.map(kind => execution("outer", 3100, 8000, kind))]);
    assert.equal(result.generation.available, false);
  }
});

test("saved generation totals must match ordinary response coverage before any of the three speeds accept them", () => {
  const evidence = analyze([start(), ...output(), used()]);
  const good = { outputTokens: 100, durationMs: 5000, generation: evidence.generation, responseMetrics: evidence };
  assert.equal(summarizeStatusRecords([good]).sessionGeneration.measuredTurns, 1);
  for (const changed of [
    { ...evidence.generation, outputTokens: 50, intervalOutputTokens: 49 },
    { ...evidence.generation, ordinaryResponses: 2, measuredResponses: 2, intervalOutputTokens: 98 },
  ]) {
    const status = summarizeStatusRecords([{ ...good, generation: changed }]);
    assert.equal(status.latest.generation.available, false);
    assert.equal(status.recentGeneration.measuredTurns, 0);
    assert.equal(status.sessionGeneration.measuredTurns, 0);
    assert.equal(status.modelGroups[0].generationMeasuredTurns, 0);
  }
});

test("late tool timing is resolved through a call/return identity and cannot pollute the next response", () => {
  const result = analyze([start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050),
    execution(), returned(), legacy(400, 100, 400, 9100),
    item("answer", 10000, 11000), used("b", 100, 0, 11200)]);
  assert.equal(result.generation.available, true);
  assert.equal(result.generation.durationMs, 3000);
  assert.equal(result.generation.intervalOutputTokens, 498);
  assert.equal(result.generation.tps, 166);
});

test("parallel native tools inside one identified wrapper exclude every execution duration", () => {
  const result = analyze([start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050),
    execution("one", 3100, 6000), execution("two", 3200, 8000, "Extension"), returned()]);
  assert.equal(result.generation.durationMs, 2000);
  assert.equal(result.generation.tps, 199.5);
  const unknown = analyze([start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050),
    execution("known", 3100, 6000), execution("unknown", 3200, 8000, "FutureToolType"), returned()]);
  assert.equal(unknown.generation.available, false);
  assert.equal(unknown.generation.exclusionReasons.tool_argument_timing_unconfirmed, 1);
});

test("call return identities and unique envelopes are required; conflicting returns and crossed responses stay unavailable", () => {
  const body = [start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050), execution()];
  for (const extra of [[], [returned("different")], [returned(), returned("outer", 9200)]]) {
    const result = analyze([...body, ...extra]);
    assert.equal(result.generation.available, false);
    assert.equal(result.generation.exclusionReasons.tool_argument_timing_unconfirmed, 1);
  }
  const crossed = analyze([start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050),
    item("second", 4000, 4500, "Reasoning"), call("second", 5000), used("b", 200, 50, 5100),
    execution("ambiguous", 5200, 8000), returned(), returned("second", 9100)]);
  assert.equal(crossed.generation.available, false);
  assert.equal(crossed.generation.exclusionReasons.tool_argument_timing_unconfirmed, 2);
});

test("persisted arguments after execution starts and invalid or conflicting native tool spans cannot yield TPS", () => {
  const body = [start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050)];
  for (const toolRows of [[execution("n", 2500, 8000)], [execution("n", 3100, 8000), execution("n", 3200, 8100)],
    [execution("n", -100, 8000)], [execution("n", 8000, 7000)]]) {
    const result = analyze([...body, ...toolRows, returned()]);
    assert.equal(result.generation.available, false);
    assert.equal(result.generation.tps, null);
  }
});

test("tool execution overlapping plain output cannot be hidden by a response boundary", () => {
  const result = analyze([start(), item(), used("a", 100, 0), execution("n", 1500, 8000)]);
  assert.equal(result.generation.available, false);
  assert.equal(result.generation.exclusionReasons.tool_execution_overlaps_output, 1);
});

test("native output timing arriving after usage associates by item ID without moving to the next response", () => {
  const late = item("answer"); late.timestamp = new Date(BASE + 2500).toISOString();
  const result = analyze([start(), row("response_item", { type: "message", role: "assistant", id: "answer" }, 2000),
    used("a", 100, 0, 2200), late, item("next", 3000, 4000), used("b", 100, 0, 4200)]);
  assert.equal(result.generation.available, true);
  assert.equal(result.generation.durationMs, 2000);
});

test("raw model identities cannot substitute an unrelated native item of the same kind", () => {
  const result = analyze([start(), item(), row("response_item", { type: "message", role: "assistant", id: "other" }, 2000), used("a", 100, 0)]);
  assert.equal(result.generation.exclusionReasons.unmatched_model_output, 1);
});

test("explicit zero reasoning usage ignores only empty reasoning shells, preserving positive or unknown reasoning failures", () => {
  const shell = item("shell", 500, 500, "Reasoning");
  shell.payload.item.summary_text = []; shell.payload.item.raw_content = [];
  const rawShell = row("response_item", { type: "reasoning", id: "shell", summary: [], encrypted_content: "OPAQUE" }, 510);
  const body = [start(), shell, rawShell, item(), row("response_item", { type: "message", role: "assistant", id: "item" }, 2005)];
  const valid = analyze([...body, used("a", 157, 0)]);
  assert.equal(valid.generation.durationMs, 1005);
  assert.equal(valid.generation.tps, 156 / 1.005);
  for (const reasoning of [1, null]) {
    const boundary = used("a", 157, reasoning);
    if (reasoning === null) delete boundary.payload.usage.reasoning_output_tokens;
    const result = analyze([...body, boundary]);
    assert.equal(result.generation.available, false);
  }
  const nonempty = structuredClone(shell); nonempty.payload.item.raw_content = ["visible"];
  assert.equal(analyze([start(), nonempty, rawShell, item(), used("a", 157, 0)]).generation.available, false);
});

test("redacted real-session regressions recover 157 and 5351 tokens without including execution time", () => {
  for (const tokens of [157, 5351]) {
    const fixture = JSON.parse(fs.readFileSync(new URL(`./fixtures/timing-${tokens}.json`, import.meta.url), "utf8"));
    const result = analyze(fixture.rows);
    assert.equal(result.generation.available, true);
    assert.equal(result.outputTokens, fixture.expected.outputTokens);
    assert.equal(result.generation.measuredResponses, fixture.expected.responses);
    assert.equal(result.generation.durationMs, fixture.expected.durationMs);
    assert.equal(result.generation.intervalOutputTokens, fixture.expected.intervalOutputTokens);
    assert.equal(result.generation.measuredOutputTokenFraction, 1);
  }
});

test("completion backfill refreshes late tool evidence once and preserves original capture order", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tps-late-evidence-"));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const transcript = path.join(directory, "synthetic.jsonl");
  // Backfill reads the real clock. Keep this synthetic completed turn recent
  // instead of letting a fixed calendar date exceed the production 24h bound.
  const offset = Date.now() - BASE - 15000;
  const liveText = rows => text(rows.map(record => {
    const shifted = structuredClone(record);
    shifted.timestamp = new Date(Date.parse(record.timestamp) + offset).toISOString();
    for (const key of ["started_at_ms", "completed_at_ms"]) {
      if (Number.isSafeInteger(shifted.payload[key])) shifted.payload[key] += offset;
    }
    return shifted;
  }));
  const initial = [start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100, 3050)];
  fs.writeFileSync(transcript, liveText(initial));
  const metric = extractStopMetric(transcript, "turn", { nowMs: BASE + offset + 5000, sessionId: "session" });
  const before = recordStopMetric({ dataDir: directory, sessionId: "session", turnId: "turn", metric, capturedAt: new Date(BASE + 5000) });
  assert.equal(before.latest.generation.available, false);
  fs.appendFileSync(transcript, liveText([execution(), returned(), event({ type: "task_complete", turn_id: "turn", duration_ms: 10000 }, 10000)]));
  const input = { transcript_path: transcript, turn_id: "turn", session_id: "session" };
  const result = await waitAndBackfill(input, { dataDir: directory, maxWaitMs: 30, pollMs: 5 });
  assert.equal(result.updated, true);
  assert.equal(result.status.latest.generation.available, true);
  assert.equal(result.status.latest.generation.tps, 199.5);
  assert.equal(result.status.latest.capturedAt, before.latest.capturedAt);
  assert.equal(result.status.latest.completedDurationMs, 10000);
  assert.equal((await waitAndBackfill(input, { dataDir: directory, maxWaitMs: 30, pollMs: 5 })).reason, "already_backfilled");
});

test("recent comparisons use the last five complete same-setting turns and token/time weighting", () => {
  const context = { model: "one", provider: "provider", reasoningEffort: "high" };
  const g = analyze([start(), item(), used("a", 100, 0)]).generation;
  const records = Array.from({ length: 7 }, (_, i) => ({ outputTokens: 100, durationMs: 20000, context,
    generation: { ...g, durationMs: i === 6 ? 9000 : 1000 } }));
  records.push({ outputTokens: 10000, durationMs: 20000, context: { ...context, provider: "other" }, generation: { ...g } });
  records.push({ outputTokens: 5000, durationMs: 20000, context });
  const status = summarizeStatusRecords(records);
  assert.equal(status.recentGeneration.measuredTurns, 5);
  assert.equal(status.recentGeneration.eligibleTurns, 7);
  assert.equal(status.recentGeneration.excludedTurns, 1);
  assert.equal(status.recentGeneration.tps, 495 / 13);
  assert.equal(status.recentGeneration.latestTurnIncluded, false);
  assert.equal(status.sessionGeneration.measuredTurns, 7);
  assert.equal(status.sessionGeneration.tps, 693 / 15);
  assert.equal(status.sessionGeneration.excludedTurns, 1);
  assert.equal(status.sessionGeneration.latestTurnIncluded, false);
  assert.equal(status.sessionGeneration.sampleLimit, null);
  assert.equal(status.sessionGeneration.historyScope, "retained-session-records");
  assert.match(formatStatusLine(status), /本轮 暂不可测 · 近期完整 ≈38.1 tok\/s（5轮） · 会话完整 ≈46.2 tok\/s（7轮）/);
  assert.equal(status.latest.generation, null);
  assert.match(formatStatusLine(status), /暂不可测/);
  assert.match(formatRecentGeneration(status), /近期完整同设置加权.*最近 5 个完整计时轮次/);
});

test("unavailable Hook gives a compact reason; query details expose partial coverage without a partial TPS", () => {
  const g = analyze([start(), item("r", 1000, 2000, "Reasoning"), call(), used("a", 400, 100)]).generation;
  const status = summarizeStatusRecords([{ outputTokens: 400, durationMs: 5000, generation: g }]);
  assert.equal(formatStatusLine(status), "⚡ 生成 TPS 估计 · 本轮 暂不可测（工具计时未匹配） · 近期完整 暂无有效样本 · 会话完整 暂无有效样本 · 输出 400 tok");
  assert.match(formatStatusDetails(status), /计时覆盖：0\/1.*输出 token 覆盖 0.0%/);
  assert.match(formatStatusDetails(status), /暂无有效样本/);
});

test("local details, recent and JSON commands query saved evidence without a model", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tps-query-"));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const transcript = path.join(directory, "fixture.jsonl");
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/timing-5351.json", import.meta.url), "utf8"));
  fs.writeFileSync(transcript, text(fixture.rows));
  const metric = extractStopMetric(transcript, "turn", { sessionId: "session", nowMs: BASE + 200000 });
  assert.equal(metric.generation.available, true);
  recordStopMetric({ dataDir: directory, sessionId: "session", turnId: "first", metric });
  recordStopMetric({ dataDir: directory, sessionId: "session", turnId: "second", metric });
  const run = flag => execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/status.mjs", import.meta.url)),
    "--data-dir", directory, "--session-id", "session", flag], { encoding: "utf8", windowsHide: true });
  assert.match(run("--details"), /本轮 ≈45.1.*近期完整 ≈45.1.*会话完整 ≈45.1.*\n计时覆盖：8\/8.*100.0%\n近期完整同设置加权/);
  assert.match(run("--recent"), /^近期完整同设置加权：≈45.1.*最近 2 个完整计时轮次/);
  const json = JSON.parse(run("--json"));
  assert.equal(json.recentGeneration.measuredTurns, 2);
  assert.equal(json.recentGeneration.latestTurnIncluded, true);
  assert.equal(json.sessionGeneration.measuredTurns, 2);
  assert.equal(json.sessionGeneration.tps, json.recentGeneration.tps);
});

test("session comparisons separate model, provider and reasoning effort with token/time weighting", () => {
  const status = summarizeStatusRecords([
    { outputTokens: 100, durationMs: 1000, context: { model: "one", reasoningEffort: "high" } },
    { outputTokens: 100, durationMs: 9000, context: { model: "one", reasoningEffort: "high" } },
    { outputTokens: 500, durationMs: 1000, context: { model: "two", reasoningEffort: "high" } },
    { outputTokens: 600, durationMs: 1000, context: { model: "one", reasoningEffort: "low" } },
    { outputTokens: 700, durationMs: 1000 },
  ]);
  assert.equal(status.modelGroups.length, 4);
  assert.equal(status.modelGroups[0].totalOutputThroughput, 20);
  assert.equal(status.modelGroups[3].model, null);
});

test("three-speed Hook keeps missing current timing distinct and excludes other settings and older methods", () => {
  const g = analyze([start(), item(), used("a", 100, 0)]).generation;
  const context = { model: "one", provider: "provider", reasoningEffort: "high" };
  const measured = { outputTokens: 100, durationMs: 20000, generation: g, context };
  const status = summarizeStatusRecords([measured,
    { ...measured, generation: { ...g, durationMs: 9000 }, context: { ...context, model: "other" } },
    { ...measured, context: { ...context, provider: "other" } },
    { ...measured, context: { ...context, reasoningEffort: "low" } },
    { ...measured, generation: { ...g, measurementVersion: 2 } },
    { outputTokens: 10000, durationMs: 20000, context },
  ]);
  for (const metric of [status.recentGeneration, status.sessionGeneration]) {
    assert.equal(metric.measuredTurns, 1);
    assert.equal(metric.matchingTurns, 3);
    assert.equal(metric.excludedTurns, 2);
    assert.equal(metric.tps, 99);
    assert.equal(metric.latestTurnIncluded, false);
  }
  assert.equal(formatStatusLine(status), "⚡ 生成 TPS 估计 · 本轮 暂不可测 · 近期完整 ≈99.0 tok/s（1轮） · 会话完整 ≈99.0 tok/s（1轮） · 输出 10.0k tok");
});

test("generation history weights valid inter-token intervals without mixing missing or old measurements", () => {
  const first = analyze([start(), ...output(), used()]).generation;
  const second = analyze([start(), ...output("long", 1000, 10000), used("long-response", 100, 20, 10200)]).generation;
  const context = { model: "one", reasoningEffort: "high" };
  const status = summarizeStatusRecords([
    { outputTokens: 100, durationMs: 5000, generation: first, context },
    { outputTokens: 100, durationMs: 12000, generation: second, context },
    { outputTokens: 10000, durationMs: 50000, context },
  ]);
  assert.equal(status.modelGroups[0].generationMeasuredTurns, 2);
  assert.equal(status.modelGroups[0].generationIntervalTokens, 198);
  assert.equal(status.modelGroups[0].outputSpeedEstimate, 19.8);
  assert.equal(status.latest.generation, null);
  assert.equal(formatStatusLine(status), "⚡ 生成 TPS 估计 · 本轮 暂不可测 · 近期完整 ≈19.8 tok/s（2轮） · 会话完整 ≈19.8 tok/s（2轮） · 输出 10.0k tok");
});
