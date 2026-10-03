import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { analyzeResponseMetrics } from "../scripts/response-metrics.mjs";
import { summarizeStatusRecords, formatStatusLine, formatStatusDetails } from "../scripts/status-core.mjs";

const BASE = Date.parse("2026-10-02T00:00:00Z");
const row = (type, payload, ms) => ({ timestamp: new Date(BASE + ms).toISOString(), type, payload });
const start = () => row("event_msg", { type: "task_started", turn_id: "turn" }, 0);
const item = (id, from, to, kind = "AgentMessage", extra = {}) => row("event_msg", {
  type: "item_completed", item: { type: kind, id, ...extra }, started_at_ms: BASE + from, completed_at_ms: BASE + to,
}, to);
const used = (id, tokens, ms) => row("token_usage_record", {
  thread_id: "session", turn_id: "turn", response_id: id, usage: { output_tokens: tokens, reasoning_output_tokens: 0 },
}, ms);
const call = (id, ms) => row("response_item", { type: "custom_tool_call", id: `raw-${id}`, call_id: id }, ms);
const returned = (id, ms) => row("response_item", { type: "custom_tool_call_output", call_id: id }, ms);
const analyze = rows => analyzeResponseMetrics(rows.map(JSON.stringify).join("\n"), "turn", { sessionId: "session" });
const complete = () => analyze([start(), item("a", 1000, 2000), used("a", 100, 2200)]);
const partialRows = () => [start(), item("a", 1000, 2000), used("a", 100, 2200), call("b", 3000), used("b", 400, 3200)];
const partial = () => analyze(partialRows());
const context = { model: "model", provider: "provider", reasoningEffort: "high" };
const record = (metric, extra = {}) => ({ outputTokens: metric.outputTokens, durationMs: 20000,
  responseMetrics: metric, generation: metric.generation, context, ...extra });

test("partial timing shows only the verified subset, with token coverage and separate histories", () => {
  const metric = partial();
  assert.equal(metric.generation.available, false);
  assert.equal(metric.generation.tps, null);
  assert.equal(metric.generation.sampleAvailable, true);
  assert.equal(metric.generation.measuredTps, 99);
  assert.equal(metric.generation.measuredOutputTokenFraction, 0.2);
  const status = summarizeStatusRecords([record(complete()), record(metric)]);
  assert.equal(status.displayMetric, "generation_tps_partial");
  assert.equal(status.recentGeneration.measuredTurns, 1);
  assert.equal(status.recentPartialGeneration.measuredTurns, 1);
  assert.equal(status.recentGeneration.latestTurnIncluded, false);
  assert.equal(status.recentPartialGeneration.latestTurnIncluded, true);
  assert.equal(formatStatusLine(status), "⚡ 生成 TPS 估计 · 本轮已测 ≈99.0 tok/s（覆盖20.0%，短输出） · 近期已测 ≈99.0 tok/s（1轮） · 会话已测 ≈99.0 tok/s（1轮） · 输出 500 tok");
  assert.match(formatStatusDetails(status), /计时覆盖：1\/2.*20.0%/);
  assert.match(formatStatusDetails(status), /近期完整 ≈99.0.*会话完整 ≈99.0/);
});

test("parse loss, conflicts, interruption, pending output and response overlap never expose partial speed", () => {
  const broken = [
    [...partialRows(), null],
    [...partialRows(), used("a", 200, 3400)],
    [...partialRows(), row("event_msg", { type: "turn_aborted" }, 3400)],
    [...partialRows(), item("pending", 4000, 5000)],
    [start(), item("a", 1000, 2000), used("a", 100, 2200), item("b", 1500, 2500), used("b", 100, 2700)],
    [...partialRows(), used("unknown", 50, 3400)],
  ];
  for (const rows of broken) {
    const metric = analyze(rows);
    assert.equal(metric.generation.sampleAvailable, false);
    assert.equal(metric.generation.measuredTps, null);
    assert.doesNotMatch(formatStatusLine(summarizeStatusRecords([record(metric)])), /本轮已测/);
  }
});

test("invalid saved partial evidence cannot enter either history or the current display", () => {
  const metric = partial();
  for (const changed of [
    { measuredOutputTokenFraction: 1 }, { measurementVersion: 3 }, { coverageType: "complete" },
    { measuredResponses: 2 }, { intervalOutputTokens: 100 }, { durationMs: 30000 },
    { excludedResponses: 0 }, { exclusionReasons: { transcript_parse_error: 1 } },
  ]) {
    const status = summarizeStatusRecords([record(metric, { generation: { ...metric.generation, ...changed } })]);
    assert.equal(status.latest.generation.sampleAvailable, false);
    assert.equal(status.latest.generation.measuredTps, null);
    assert.equal(status.recentPartialGeneration.measuredTurns, 0);
    assert.equal(status.sessionPartialGeneration.measuredTurns, 0);
    assert.match(formatStatusLine(status), /计时证据未通过校验/);
  }
});

test("partial history uses token/time weighting and matching settings without mixing complete samples", () => {
  const a = partial();
  const b = analyze([start(), item("a", 1000, 10000), used("a", 200, 10200), call("b", 11000), used("b", 400, 11200)]);
  const status = summarizeStatusRecords([record(complete()), record(a),
    record(a, { context: { ...context, model: "other" } }), record(b)]);
  assert.equal(status.recentGeneration.measuredTurns, 1);
  assert.equal(status.recentPartialGeneration.measuredTurns, 2);
  assert.equal(status.recentPartialGeneration.tps, 298 / 10);
  assert.equal(status.sessionPartialGeneration.tps, 298 / 10);
  assert.equal(status.recentPartialGeneration.measuredOutputTokenFraction, 300 / 1100);
  assert.equal(status.recentPartialGeneration.eligibleTurns, 2);
});

test("stale complete history is marked after five same-setting turns or one hour", () => {
  const first = record(complete(), { capturedAt: "2026-10-02T00:00:00Z" });
  const missing = { outputTokens: 100, durationMs: 20000, context };
  const byTurns = summarizeStatusRecords([first, ...Array.from({ length: 5 }, () => ({ ...missing }))]);
  assert.equal(byTurns.recentGeneration.turnsSinceLastSample, 5);
  assert.equal(byTurns.recentGeneration.stale, true);
  assert.match(formatStatusLine(byTurns), /近期完整 ≈99.0 tok\/s（1轮，旧样本）/);
  const byAge = summarizeStatusRecords([first, { ...missing, capturedAt: "2026-10-02T01:00:00Z" }], { nowMs: BASE + 3600000 });
  assert.equal(byAge.sessionGeneration.sampleAgeMs, 3600000);
  assert.equal(byAge.sessionGeneration.stale, true);
  assert.equal(summarizeStatusRecords([first, { ...missing, capturedAt: "2026-10-02T00:59:59Z" }], { nowMs: BASE + 3599000 }).recentGeneration.stale, false);
  assert.equal(summarizeStatusRecords([first], { nowMs: BASE + 7200000 }).recentGeneration.stale, true);
});

test("completed version-3 samples remain compatible, but version-3 partials are not promoted", () => {
  const older = record(complete(), { generation: { ...complete().generation, measurementVersion: 3 } });
  const untrusted = record(partial(), { generation: { ...partial().generation, measurementVersion: 3 } });
  const status = summarizeStatusRecords([older, untrusted]);
  assert.equal(status.recentGeneration.measuredTurns, 1);
  assert.equal(status.recentPartialGeneration.measuredTurns, 0);
});

test("FileChange timing associates through the identified wrapper and excludes file execution", () => {
  const metric = analyze([start(), item("a", 1000, 2000), call("outer", 3000), used("a", 100, 3200),
    item("file", 3300, 5000, "FileChange", { status: "completed" }), returned("outer", 5200)]);
  assert.equal(metric.generation.available, true);
  assert.equal(metric.generation.durationMs, 2000);
  assert.equal(metric.generation.tps, 49.5);
});

test("uniquely identified detached commands do not attach to later polls or suppress subsequent generation", () => {
  const rows = [start(), item("a", 1000, 2000), call("launch", 3000), used("a", 100, 3100), returned("launch", 4500),
    item("b", 5000, 6000), call("poll", 6500), used("b", 100, 6600),
    item("process", 3200, 7000, "CommandExecution", { status: "completed" }),
    item("poll-native", 6700, 7100, "CommandExecution", { status: "completed" }), returned("poll", 7500),
    item("c", 8000, 9000), used("c", 100, 9200)];
  const metric = analyze(rows);
  assert.equal(metric.generation.available, true);
  assert.equal(metric.generation.durationMs, 4500);
  assert.equal(metric.generation.tps, 297 / 4.5);
  // Unknown status cannot prove detached execution, and blocking overlap still fails.
  const unknown = structuredClone(rows);
  delete unknown[8].payload.item.status;
  assert.equal(analyze(unknown).generation.available, false);
  const blocking = analyze([start(), item("a", 1000, 2000), used("a", 100, 2200),
    item("process", 1500, 7000, "CommandExecution", { status: "completed" })]);
  assert.equal(blocking.generation.exclusionReasons.tool_execution_overlaps_output, 1);
});

test("ambiguous call envelopes never identify a command as detached", () => {
  const metric = analyze([start(), item("a", 1000, 2000), call("one", 3000), used("a", 100, 3100),
    item("b", 4000, 4500), call("two", 4600), used("b", 100, 4700), returned("one", 5500), returned("two", 6000),
    item("process", 5000, 7000, "CommandExecution", { status: "completed" })]);
  assert.equal(metric.generation.available, false);
  assert.equal(metric.generation.sampleAvailable, false);
});

test("tool-heavy real regression recovers valid windows without claiming complete coverage or counting compaction", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/timing-tool-heavy.json", import.meta.url), "utf8"));
  const metric = analyze(fixture.rows);
  assert.equal(metric.outputTokens, 15684);
  assert.equal(metric.scopes.ordinary.outputTokens, 10546);
  assert.equal(metric.scopes.compaction.outputTokens, 5138);
  assert.equal(metric.generation.available, false);
  assert.equal(metric.generation.sampleAvailable, true);
  assert.equal(metric.generation.measuredResponses, 14);
  assert.equal(metric.generation.durationMs, 131302);
  assert.equal(metric.generation.intervalOutputTokens, 7880);
  assert.deepEqual(metric.generation.exclusionReasons, { unconfirmed_tool_start: 3, tool_argument_timing_unconfirmed: 3 });
  const status = summarizeStatusRecords([record(metric, { durationMs: 421520 })]);
  assert.match(formatStatusLine(status), /本轮已测 ≈60.0 tok\/s（覆盖74.9%）/);
  assert.match(formatStatusLine(status), /输出 10.5k tok$/);
});
