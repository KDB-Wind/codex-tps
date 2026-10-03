import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeResponseMetrics } from "./response-metrics.mjs";

const STATUS_SCHEMA_VERSION = 8;
const SHORT_RESPONSE_TOKENS_PER_REQUEST = 128;
const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const MAX_TURN_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_FILES = 200;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const STATUS_FILE_PATTERN = /^\d+-[0-9a-f]{12}-[0-9a-f]{10}\.json$/;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function hashId(value) {
  if (typeof value !== "string" || !value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function usageFrom(payload) {
  const usage = payload?.info?.last_token_usage;
  if (!usage || typeof usage !== "object") return null;
  const outputTokens = finiteNumber(usage.output_tokens);
  const reasoningTokens = finiteNumber(usage.reasoning_output_tokens);
  const totalOutputTokens = finiteNumber(payload?.info?.total_token_usage?.output_tokens);
  if (outputTokens === null || outputTokens < 0) return null;
  return {
    outputTokens,
    reasoningTokens:
      reasoningTokens !== null && reasoningTokens >= 0 && reasoningTokens <= outputTokens
        ? reasoningTokens
        : null,
    totalOutputTokens: totalOutputTokens !== null && totalOutputTokens >= 0 ? totalOutputTokens : null,
  };
}

function timestampMs(record, fallbackSeconds = null) {
  const parsed = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const seconds = finiteNumber(fallbackSeconds);
  return seconds === null ? null : seconds * 1000;
}

export function readTail(file, byteLimit, fileSystem = fs) {
  const stat = fileSystem.statSync(file);
  const length = Math.min(stat.size, byteLimit);
  const start = Math.max(0, stat.size - length);
  const buffer = Buffer.allocUnsafe(length);
  const handle = fileSystem.openSync(file, "r");
  let bytesRead = 0;
  try {
    bytesRead = fileSystem.readSync(handle, buffer, 0, length, start);
  } finally {
    fileSystem.closeSync(handle);
  }
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (start > 0) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  return { text, start, sizeBytes: stat.size };
}

function scanCurrentTurn(text, currentTurnId, options = {}) {
  let owner = options.sessionId || null;
  let lastCumulativeOutput = null;
  let activeTurnId = null;
  let startedAtMs = null;
  let foundStart = false;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let reasoningKnown = true;
  let tokenCountEvents = 0;
  let duplicateTokenCountEvents = 0;
  let toolCallCount = 0;
  let parseErrorCount = 0;
  let requestStartAtMs = null;
  let latestModelActivityAtMs = null;
  let requestDurationMs = 0;
  let estimatedOutputTokens = 0;
  let estimatedReasoningTokens = 0;
  let estimatedReasoningKnown = true;
  let estimatedRequestCount = 0;
  let unestimatedRequestCount = 0;
  const seenCumulativeOutput = new Set();
  let usageDeduplicationUnavailable = false;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      parseErrorCount += 1;
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (record.type === "session_meta") owner ??= payload.id || null;
    if (payload.thread_id && owner && payload.thread_id !== owner) continue;
    const observedCumulative = payload.type === "token_count"
      ? finiteNumber(payload.info?.total_token_usage?.output_tokens) : null;
    if (activeTurnId !== currentTurnId && observedCumulative !== null) lastCumulativeOutput = observedCumulative;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      if (activeTurnId === currentTurnId) {
        foundStart = true;
        startedAtMs = timestampMs(record, payload.started_at);
        outputTokens = 0;
        reasoningTokens = 0;
        reasoningKnown = true;
        tokenCountEvents = 0;
        duplicateTokenCountEvents = 0;
        toolCallCount = 0;
        requestStartAtMs = startedAtMs;
        latestModelActivityAtMs = null;
        requestDurationMs = 0;
        estimatedOutputTokens = 0;
        estimatedReasoningTokens = 0;
        estimatedReasoningKnown = true;
        estimatedRequestCount = 0;
        unestimatedRequestCount = 0;
        seenCumulativeOutput.clear();
        if (lastCumulativeOutput !== null) seenCumulativeOutput.add(lastCumulativeOutput);
        usageDeduplicationUnavailable = false;
      }
      continue;
    }
    if (payload.type === "task_complete") {
      if (payload.turn_id === activeTurnId || !payload.turn_id) activeTurnId = null;
      continue;
    }
    if (!foundStart || activeTurnId !== currentTurnId) continue;
    if (payload.turn_id && payload.turn_id !== currentTurnId) continue;
    if (record.type === "response_item") {
      const isAssistantMessage = payload.type === "message" && payload.role === "assistant";
      const isModelActivity = isAssistantMessage || [
        "reasoning",
        "function_call",
        "custom_tool_call",
        "local_shell_call",
        "mcp_tool_call",
        "web_search_call",
      ].includes(payload.type);
      if (isModelActivity) {
        const activityAtMs = timestampMs(record);
        if (activityAtMs !== null) latestModelActivityAtMs = activityAtMs;
      }
    }
    if (payload.type === "token_count") {
      const usage = usageFrom(payload);
      if (!usage) continue;
      // Equal counts do not identify a request. Without cumulative evidence we
      // cannot distinguish a repeated broadcast from another real response.
      if (usage.totalOutputTokens === null && usage.outputTokens > 0) {
        usageDeduplicationUnavailable = true;
      }
      const duplicate = usage.totalOutputTokens !== null &&
        seenCumulativeOutput.has(usage.totalOutputTokens);
      if (duplicate) {
        duplicateTokenCountEvents += 1;
        continue;
      }
      if (usage.totalOutputTokens !== null) seenCumulativeOutput.add(usage.totalOutputTokens);
      const tokenCountAtMs = timestampMs(record);
      const responseEndAtMs = latestModelActivityAtMs ?? tokenCountAtMs;
      if (
        usage.outputTokens > 0 &&
        requestStartAtMs !== null &&
        responseEndAtMs !== null &&
        responseEndAtMs > requestStartAtMs
      ) {
        const intervalDurationMs = responseEndAtMs - requestStartAtMs;
        if (intervalDurationMs <= MAX_TURN_DURATION_MS) {
          requestDurationMs += intervalDurationMs;
          estimatedOutputTokens += usage.outputTokens;
          if (usage.reasoningTokens === null) estimatedReasoningKnown = false;
          else estimatedReasoningTokens += usage.reasoningTokens;
          estimatedRequestCount += 1;
        } else {
          unestimatedRequestCount += 1;
        }
      } else if (usage.outputTokens > 0) {
        unestimatedRequestCount += 1;
      }
      outputTokens += usage.outputTokens;
      if (usage.reasoningTokens === null) reasoningKnown = false;
      else reasoningTokens += usage.reasoningTokens;
      tokenCountEvents += 1;
      if (tokenCountAtMs !== null) requestStartAtMs = tokenCountAtMs;
      latestModelActivityAtMs = null;
    }
    if (
      record.type === "response_item" &&
      ["function_call", "custom_tool_call", "local_shell_call", "mcp_tool_call"].includes(payload.type)
    ) {
      toolCallCount += 1;
    }
  }

  return {
    foundStart,
    usageDeduplicationUnavailable,
    startedAtMs,
    outputTokens,
    reasoningTokens: reasoningKnown ? reasoningTokens : null,
    nonReasoningOutputTokens: reasoningKnown ? outputTokens - reasoningTokens : null,
    tokenCountEvents,
    duplicateTokenCountEvents,
    toolCallCount,
    parseErrorCount,
    requestDurationMs,
    estimatedOutputTokens,
    estimatedReasoningTokens: estimatedReasoningKnown ? estimatedReasoningTokens : null,
    estimatedNonReasoningOutputTokens:
      estimatedReasoningKnown ? estimatedOutputTokens - estimatedReasoningTokens : null,
    estimatedRequestCount,
    unestimatedRequestCount,
  };
}

function scanTurnCompletion(text, currentTurnId) {
  let activeTurnId = null;
  let parseErrorCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      parseErrorCount += 1;
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      continue;
    }
    if (payload.type !== "task_complete") continue;
    const completedTurnId =
      typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : activeTurnId;
    if (completedTurnId === currentTurnId) {
      return {
        found: true,
        ttftMs: finiteNumber(payload.time_to_first_token_ms),
        completedDurationMs: finiteNumber(payload.duration_ms),
        parseErrorCount,
      };
    }
    if (completedTurnId === activeTurnId) activeTurnId = null;
  }
  return { found: false, parseErrorCount };
}

function scanPreviousTurnCompletion(text, currentTurnId) {
  let activeTurnId = null;
  let previous = null;
  let foundCurrentStart = false;
  let parseErrorCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      parseErrorCount += 1;
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      if (activeTurnId === currentTurnId) {
        foundCurrentStart = true;
        break;
      }
      continue;
    }
    if (payload.type !== "task_complete") continue;
    const completedTurnId =
      typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : activeTurnId;
    if (completedTurnId && completedTurnId !== currentTurnId) {
      previous = {
        turnId: completedTurnId,
        ttftMs: finiteNumber(payload.time_to_first_token_ms),
        completedDurationMs: finiteNumber(payload.duration_ms),
      };
    }
    if (completedTurnId === activeTurnId) activeTurnId = null;
  }
  return { foundCurrentStart, previous, parseErrorCount };
}

function validatedCompletion(scanned, metadata = {}) {
  const rawTtftMs = finiteNumber(scanned?.ttftMs);
  const rawCompletedDurationMs = finiteNumber(scanned?.completedDurationMs);
  const completedDurationMs =
    rawCompletedDurationMs !== null &&
    rawCompletedDurationMs > 0 &&
    rawCompletedDurationMs <= MAX_TURN_DURATION_MS
      ? rawCompletedDurationMs
      : null;
  const ttftMs =
    rawTtftMs !== null &&
    rawTtftMs >= 0 &&
    rawTtftMs <= MAX_TURN_DURATION_MS &&
    (completedDurationMs === null || rawTtftMs <= completedDurationMs)
      ? rawTtftMs
      : null;
  if (ttftMs === null && completedDurationMs === null) {
    return { available: false, reason: "completion_timing_missing_or_invalid", ...metadata };
  }
  return {
    available: true,
    source: "transcript-task-complete-delayed",
    ttftMs,
    completedDurationMs,
    ...metadata,
  };
}

export function extractTurnCompletion(transcriptPath, currentTurnId, options = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { available: false, reason: "transcript_not_provided" };
  }
  if (typeof currentTurnId !== "string" || !currentTurnId) {
    return { available: false, reason: "turn_not_provided" };
  }
  const maxTailBytes = Math.max(
    INITIAL_TAIL_BYTES,
    Math.min(finiteNumber(options.maxTailBytes) ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES)
  );
  let byteLimit = Math.min(INITIAL_TAIL_BYTES, maxTailBytes);
  let tail;
  let scanned;
  try {
    for (;;) {
      tail = readTail(transcriptPath, byteLimit);
      scanned = scanTurnCompletion(tail.text, currentTurnId);
      if (scanned.found || tail.start === 0 || byteLimit >= maxTailBytes) break;
      byteLimit = Math.min(byteLimit * 2, maxTailBytes);
    }
  } catch {
    return { available: false, reason: "transcript_unreadable" };
  }
  if (!scanned.found) {
    return {
      available: false,
      reason: tail.start > 0 ? "turn_exceeds_tail_limit_or_not_complete" : "turn_not_complete",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  return validatedCompletion(scanned, {
    parseErrorCount: scanned.parseErrorCount,
    scannedBytes: tail.sizeBytes - tail.start,
  });
}

// One bounded initial scan, then only appended bytes. Keep an incomplete line
// as bytes so a write splitting a UTF-8 character can be retried losslessly.
export function createTurnCompletionReader(transcriptPath, currentTurnId, options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  const limit = Math.max(INITIAL_TAIL_BYTES,
    Math.min(finiteNumber(options.maxTailBytes) ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES));
  let identity = null;
  let offset = 0;
  let revision = null;
  let pending = Buffer.alloc(0);
  let activeTurnId = null;
  let discardLine = false;
  let result = { available: false, reason: "turn_not_complete" };

  function consume(line, commit = true) {
    let payload;
    try { payload = JSON.parse(line)?.payload; } catch { return; }
    if (payload?.type === "task_started" && typeof payload.turn_id === "string") {
      if (commit) activeTurnId = payload.turn_id;
    } else if (payload?.type === "task_complete") {
      const turnId = payload.turn_id || activeTurnId;
      if (turnId === currentTurnId) result = validatedCompletion({
        ttftMs: payload.time_to_first_token_ms,
        completedDurationMs: payload.duration_ms,
      });
      if (commit && turnId === activeTurnId) activeTurnId = null;
    }
  }

  return function readCompletion() {
    if (typeof transcriptPath !== "string" || !transcriptPath) {
      return { available: false, reason: "transcript_not_provided" };
    }
    if (typeof currentTurnId !== "string" || !currentTurnId) {
      return { available: false, reason: "turn_not_provided" };
    }
    let handle;
    try {
      handle = fileSystem.openSync(transcriptPath, "r");
      const stat = fileSystem.fstatSync(handle);
      const nextIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      const nextRevision = `${stat.mtimeMs}:${stat.ctimeMs}`;
      if (identity !== nextIdentity || stat.size < offset ||
          (stat.size === offset && revision !== nextRevision)) {
        offset = Math.max(0, stat.size - limit);
        pending = Buffer.alloc(0);
        activeTurnId = null;
        discardLine = offset > 0;
        result = { available: false, reason: "turn_not_complete" };
      }
      identity = nextIdentity;
      revision = nextRevision;
      if (stat.size - offset > limit) {
        offset = stat.size - limit;
        pending = Buffer.alloc(0);
        activeTurnId = null;
        discardLine = true;
      }
      while (offset < stat.size) {
        const buffer = Buffer.allocUnsafe(Math.min(INITIAL_TAIL_BYTES, stat.size - offset));
        const count = fileSystem.readSync(handle, buffer, 0, buffer.length, offset);
        if (count === 0) break;
        offset += count;
        const chunk = Buffer.concat([pending, buffer.subarray(0, count)]);
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          if (!discardLine) consume(chunk.subarray(start, end).toString("utf8"));
          discardLine = false;
          start = end + 1;
        }
        pending = Buffer.from(chunk.subarray(start));
        if (pending.length > limit) {
          pending = Buffer.alloc(0);
          discardLine = true;
        }
      }
      if (!discardLine && pending.length) consume(pending.toString("utf8"), false);
      return result;
    } catch {
      // Retry from a fresh bounded tail after replacement or temporary loss.
      identity = null;
      return { available: false, reason: "transcript_unreadable" };
    } finally {
      if (handle !== undefined) fileSystem.closeSync(handle);
    }
  };
}

export function extractPreviousTurnCompletion(transcriptPath, currentTurnId, options = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { available: false, reason: "transcript_not_provided" };
  }
  if (typeof currentTurnId !== "string" || !currentTurnId) {
    return { available: false, reason: "turn_not_provided" };
  }
  const maxTailBytes = Math.max(
    INITIAL_TAIL_BYTES,
    Math.min(finiteNumber(options.maxTailBytes) ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES)
  );
  let byteLimit = Math.min(INITIAL_TAIL_BYTES, maxTailBytes);
  let tail;
  let scanned;
  try {
    for (;;) {
      tail = readTail(transcriptPath, byteLimit);
      scanned = scanPreviousTurnCompletion(tail.text, currentTurnId);
      if (
        (scanned.foundCurrentStart && scanned.previous) ||
        tail.start === 0 ||
        byteLimit >= maxTailBytes
      ) {
        break;
      }
      byteLimit = Math.min(byteLimit * 2, maxTailBytes);
    }
  } catch {
    return { available: false, reason: "transcript_unreadable" };
  }
  if (!scanned.foundCurrentStart) {
    return {
      available: false,
      reason: tail.start > 0 ? "current_turn_exceeds_tail_limit" : "current_turn_not_found",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  if (!scanned.previous) {
    return {
      available: false,
      reason: tail.start > 0 ? "previous_turn_exceeds_tail_limit" : "previous_turn_not_found",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  return validatedCompletion(scanned.previous, {
    turnId: scanned.previous.turnId,
    parseErrorCount: scanned.parseErrorCount,
    scannedBytes: tail.sizeBytes - tail.start,
  });
}

export function extractStopMetric(transcriptPath, currentTurnId, options = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { available: false, reason: "transcript_not_provided" };
  }
  if (typeof currentTurnId !== "string" || !currentTurnId) {
    return { available: false, reason: "turn_not_provided" };
  }

  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const maxTailBytes = Math.max(
    INITIAL_TAIL_BYTES,
    Math.min(finiteNumber(options.maxTailBytes) ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES)
  );
  let byteLimit = Math.min(INITIAL_TAIL_BYTES, maxTailBytes);
  let tail;
  let scanned;
  try {
    for (;;) {
      tail = readTail(transcriptPath, byteLimit);
      scanned = scanCurrentTurn(tail.text, currentTurnId, options);
      if (scanned.foundStart || tail.start === 0 || byteLimit >= maxTailBytes) break;
      byteLimit = Math.min(byteLimit * 2, maxTailBytes);
    }
  } catch {
    return { available: false, reason: "transcript_unreadable" };
  }

  if (!scanned.foundStart) {
    return {
      available: false,
      reason: tail.start > 0 ? "turn_exceeds_tail_limit" : "turn_not_found",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  if (scanned.startedAtMs === null) {
    return { available: false, reason: "turn_start_time_missing" };
  }
  const responseMetrics = analyzeResponseMetrics(tail.text, currentTurnId, { sessionId: options.sessionId });
  if (responseMetrics.aborted || responseMetrics.hasExplicitUsage && !responseMetrics.available) {
    return { available: false, reason: responseMetrics.reason || "explicit_usage_unavailable" };
  }
  if (responseMetrics.available) {
    scanned.outputTokens = responseMetrics.outputTokens;
    scanned.reasoningTokens = responseMetrics.reasoningTokens;
    scanned.nonReasoningOutputTokens = responseMetrics.reasoningTokens !== null
      ? responseMetrics.outputTokens - responseMetrics.reasoningTokens : null;
  }
  if (!responseMetrics.available && scanned.usageDeduplicationUnavailable) {
    return { available: false, reason: "token_usage_deduplication_unavailable" };
  }
  if ((!responseMetrics.available && scanned.tokenCountEvents === 0) || scanned.outputTokens <= 0) {
    return { available: false, reason: "output_tokens_missing" };
  }
  const durationMs = nowMs - scanned.startedAtMs;
  if (durationMs <= 0 || durationMs > MAX_TURN_DURATION_MS) {
    return { available: false, reason: "turn_duration_invalid" };
  }

  const nonReasoningOutputTokens = scanned.nonReasoningOutputTokens;
  const estimatedNonReasoningOutputTokens = scanned.estimatedNonReasoningOutputTokens;
  return {
    available: true,
    source: "transcript-end-to-end-with-request-interval-diagnostics",
    usageSource: responseMetrics.usageSource,
    responseMetrics: {
      responses: responseMetrics.responses,
      duplicateResponses: responseMetrics.duplicateResponses,
      mirroredLegacy: responseMetrics.mirroredLegacy,
      scopes: responseMetrics.scopes,
    },
    generation: responseMetrics.generation,
    context: responseMetrics.context,
    outputTokens: scanned.outputTokens,
    reasoningTokens: scanned.reasoningTokens,
    nonReasoningOutputTokens,
    durationMs,
    throughput:
      nonReasoningOutputTokens !== null
        ? nonReasoningOutputTokens / (durationMs / 1000)
        : null,
    totalOutputThroughput: scanned.outputTokens / (durationMs / 1000),
    requestThroughput:
      scanned.requestDurationMs > 0 &&
      estimatedNonReasoningOutputTokens !== null &&
      scanned.estimatedRequestCount > 0
        ? estimatedNonReasoningOutputTokens / (scanned.requestDurationMs / 1000)
        : null,
    requestIntervalTotalOutputThroughput:
      scanned.requestDurationMs > 0 && scanned.estimatedOutputTokens > 0
        ? scanned.estimatedOutputTokens / (scanned.requestDurationMs / 1000)
        : null,
    requestDurationMs: scanned.requestDurationMs || null,
    estimatedOutputTokens: scanned.estimatedOutputTokens,
    estimatedReasoningTokens: scanned.estimatedReasoningTokens,
    estimatedNonReasoningOutputTokens,
    estimatedRequestCount: scanned.estimatedRequestCount,
    unestimatedRequestCount: scanned.unestimatedRequestCount,
    tokenCountEvents: scanned.tokenCountEvents,
    duplicateTokenCountEvents: scanned.duplicateTokenCountEvents,
    toolCallCount: scanned.toolCallCount,
    parseErrorCount: scanned.parseErrorCount,
    scannedBytes: tail.sizeBytes - tail.start,
  };
}

export function resolvePluginDataDir(env = process.env) {
  const explicit = env.TPS_PLUS_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim();
  if (explicit) return explicit;
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "plugins", "data", "codex-tps-plus-personal");
}

function sessionDirectory(dataDir, sessionId) {
  const sessionHash = hashId(sessionId);
  return sessionHash ? path.join(dataDir, "status", sessionHash) : null;
}

function validDurationMs(value) {
  const durationMs = finiteNumber(value);
  return durationMs !== null && durationMs > 0 && durationMs <= MAX_TURN_DURATION_MS
    ? durationMs
    : null;
}

function completedDurationForRecord(record) {
  return validDurationMs(record?.completedDurationMs);
}

function endToEndDurationForRecord(record) {
  return completedDurationForRecord(record) ?? validDurationMs(record?.durationMs);
}

function reasoningOutputForRecord(record) {
  const outputTokens = finiteNumber(record?.outputTokens);
  if (outputTokens === null || outputTokens < 0) return null;
  const reasoningTokens = finiteNumber(record?.reasoningTokens);
  if (reasoningTokens !== null && reasoningTokens >= 0 && reasoningTokens <= outputTokens) {
    return reasoningTokens;
  }
  const explicitNonReasoning = finiteNumber(record?.nonReasoningOutputTokens);
  if (
    explicitNonReasoning !== null &&
    explicitNonReasoning >= 0 &&
    explicitNonReasoning <= outputTokens
  ) {
    return outputTokens - explicitNonReasoning;
  }
  return null;
}

function nonReasoningOutputForRecord(record) {
  const outputTokens = finiteNumber(record?.outputTokens);
  const reasoningTokens = reasoningOutputForRecord(record);
  return outputTokens !== null && reasoningTokens !== null ? outputTokens - reasoningTokens : null;
}

function validTtftForRecord(record) {
  const ttftMs = finiteNumber(record?.ttftMs);
  const durationMs = endToEndDurationForRecord(record);
  if (
    ttftMs === null ||
    ttftMs < 0 ||
    ttftMs > MAX_TURN_DURATION_MS ||
    (durationMs !== null && ttftMs > durationMs)
  ) {
    return null;
  }
  return ttftMs;
}

function estimatedNonReasoningOutputForRecord(record) {
  const estimatedOutputTokens = finiteNumber(record?.estimatedOutputTokens);
  if (estimatedOutputTokens === null || estimatedOutputTokens < 0) return null;
  const explicit = finiteNumber(record?.estimatedNonReasoningOutputTokens);
  if (explicit !== null && explicit >= 0 && explicit <= estimatedOutputTokens) return explicit;
  const estimatedReasoningTokens = finiteNumber(record?.estimatedReasoningTokens);
  if (
    estimatedReasoningTokens !== null &&
    estimatedReasoningTokens >= 0 &&
    estimatedReasoningTokens <= estimatedOutputTokens
  ) {
    return estimatedOutputTokens - estimatedReasoningTokens;
  }
  if ((finiteNumber(record?.unestimatedRequestCount) ?? 0) !== 0) return null;
  const reasoningTokens = finiteNumber(record?.reasoningTokens);
  if (reasoningTokens === null || reasoningTokens < 0 || reasoningTokens > estimatedOutputTokens) {
    return null;
  }
  return estimatedOutputTokens - reasoningTokens;
}

function hasCompleteRequestMeasurement(record) {
  const estimatedNonReasoningOutputTokens = estimatedNonReasoningOutputForRecord(record);
  return (
    estimatedNonReasoningOutputTokens !== null &&
    finiteNumber(record?.estimatedOutputTokens) > 0 &&
    finiteNumber(record?.estimatedOutputTokens) === finiteNumber(record?.outputTokens) &&
    finiteNumber(record?.estimatedRequestCount) > 0 &&
    validDurationMs(record?.requestDurationMs ?? record?.inferenceDurationMs) !== null &&
    (finiteNumber(record?.unestimatedRequestCount) ?? 0) === 0
  );
}

function readStatusRecords(directory) {
  let entries;
  try {
    entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && STATUS_FILE_PATTERN.test(entry.name))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        const stat = fs.statSync(file);
        return { file, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  } catch {
    return [];
  }

  const byTurn = new Map();
  for (const entry of entries) {
    try {
      const record = JSON.parse(fs.readFileSync(entry.file, "utf8"));
      if (
        [1, 2, 3, 4, 5, 6, 7, STATUS_SCHEMA_VERSION].includes(record?.schemaVersion) &&
        typeof record.turnId === "string" &&
        finiteNumber(record.outputTokens) > 0 &&
        endToEndDurationForRecord(record) !== null
      ) {
        const previous = byTurn.get(record.turnId);
        byTurn.set(record.turnId, {
          ...record,
          ...preservedTiming(previous, record),
          capturedAt: previous?.capturedAt ?? record.capturedAt,
          __entry: entry,
        });
      }
    } catch {}
  }
  return [...byTurn.values()].sort((left, right) => {
    const leftTime = Date.parse(left.capturedAt);
    const rightTime = Date.parse(right.capturedAt);
    const safeLeft = Number.isFinite(leftTime) ? leftTime : left.__entry.mtimeMs;
    const safeRight = Number.isFinite(rightTime) ? rightTime : right.__entry.mtimeMs;
    return safeLeft - safeRight || left.__entry.name.localeCompare(right.__entry.name);
  });
}

export function pruneStatusFiles(directory, fileSystem = fs) {
  let files;
  try {
    files = fileSystem
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && STATUS_FILE_PATTERN.test(entry.name))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        const stat = fileSystem.statSync(file);
        return { file, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  } catch {
    return;
  }
  let bytes = files.reduce((total, entry) => total + entry.size, 0);
  while (files.length > MAX_SESSION_FILES || bytes > MAX_SESSION_BYTES) {
    const oldest = files.shift();
    if (!oldest) break;
    bytes -= oldest.size;
    try {
      fileSystem.unlinkSync(oldest.file);
    } catch {}
  }
}

function generationForRecord(record, coverageType = "complete") {
  const g = record?.generation;
  const ordinary = record?.responseMetrics?.scopes?.ordinary;
  const complete = coverageType === "complete";
  if (!g || (complete ? !g.available || !g.coverageComplete :
    g.available || g.coverageComplete || !g.sampleAvailable || g.coverageType !== "partial" || g.measurementVersion !== 4) ||
    g.source !== "matched-client-output-windows" ||
    ![3, 4].includes(g.measurementVersion) ||
    (complete && g.measurementVersion === 4 && (!g.sampleAvailable || g.coverageType !== "complete" ||
      g.excludedResponses !== 0 || g.measuredOutputTokenFraction !== 1)) ||
    !Number.isSafeInteger(g.outputTokens) || g.outputTokens < 0 || g.outputTokens > record.outputTokens ||
    !Number.isSafeInteger(g.measuredResponses) || g.measuredResponses <= 0 ||
    !Number.isSafeInteger(g.ordinaryResponses) || g.ordinaryResponses < g.measuredResponses ||
    (complete && g.measuredResponses !== g.ordinaryResponses) ||
    (record.responseMetrics && (!ordinary || !Number.isSafeInteger(ordinary.outputTokens) ||
      ordinary.outputTokens > record.outputTokens || ordinary.outputTokens < g.outputTokens ||
      (complete && ordinary.outputTokens !== g.outputTokens) || ordinary.responses !== g.ordinaryResponses ||
      record.responseMetrics.scopes.unclassified?.responses !== 0)) ||
    !Number.isSafeInteger(g.intervalOutputTokens) || g.intervalOutputTokens <= 0 ||
    g.intervalOutputTokens !== g.outputTokens - g.measuredResponses ||
    g.outputTokens < 2 * g.measuredResponses ||
    (complete && Object.keys(g.exclusionReasons || {}).length !== 0) ||
    validDurationMs(g.durationMs) === null || g.durationMs > endToEndDurationForRecord(record)) return null;
  if (!complete) {
    const recoverable = new Set(["unconfirmed_tool_start", "tool_argument_timing_unconfirmed", "tool_execution_overlaps_output",
      "reasoning_timing_missing", "reasoning_usage_unknown", "unconfirmed_item_span", "output_timing_missing",
      "unmatched_model_output", "insufficient_output_tokens", "conflicting_or_missing_output_evidence",
      "output_window_out_of_bounds", "non_reasoning_timing_missing", "legacy_response_identity_missing"]);
    const reasons = Object.entries(g.exclusionReasons || {});
    if (!ordinary || g.measuredResponses >= g.ordinaryResponses ||
      g.excludedResponses !== g.ordinaryResponses - g.measuredResponses ||
      reasons.some(([key, n]) => !recoverable.has(key) || !Number.isSafeInteger(n) || n <= 0) ||
      reasons.reduce((sum, [, n]) => sum + n, 0) !== g.excludedResponses ||
      record.responseMetrics.scopes.unclassified?.responses !== 0 ||
      !Number.isFinite(g.measuredOutputTokenFraction) ||
      Math.abs(g.measuredOutputTokenFraction - g.outputTokens / ordinary.outputTokens) > 1e-9) return null;
  }
  return { ...g, tps: g.intervalOutputTokens / (g.durationMs / 1000),
    coverageType, measuredOutputTokenFraction: complete ? 1 : g.measuredOutputTokenFraction };
}

function groupedSessionMetrics(records) {
  const groups = new Map();
  for (const record of records) {
    const c = record.context || {};
    const key = JSON.stringify([c.model ?? null, c.provider ?? null, c.reasoningEffort ?? null]);
    const group = groups.get(key) || { model: c.model ?? null, provider: c.provider ?? null,
      reasoningEffort: c.reasoningEffort ?? null, turns: 0, outputTokens: 0,
      durationMs: 0, generationOutputTokens: 0, generationIntervalTokens: 0, generationDurationMs: 0, generationMeasuredTurns: 0 };
    group.turns++; group.outputTokens += record.outputTokens;
    group.durationMs += endToEndDurationForRecord(record);
    const g = generationForRecord(record);
    if (g) { group.generationMeasuredTurns++; group.generationOutputTokens += g.outputTokens;
      group.generationIntervalTokens += g.intervalOutputTokens; group.generationDurationMs += g.durationMs; }
    groups.set(key, group);
  }
  return [...groups.values()].map(g => ({ ...g, totalOutputThroughput: g.outputTokens / (g.durationMs / 1000),
    outputSpeedEstimate: g.generationDurationMs > 0 ? g.generationIntervalTokens / (g.generationDurationMs / 1000) : null }));
}

function generationComparisonMetrics(records, latest, limit = 5, coverageType = "complete", nowMs = Date.now()) {
  const contextKey = r => JSON.stringify([r?.context?.model ?? null, r?.context?.provider ?? null, r?.context?.reasoningEffort ?? null]);
  const matching = records.filter(r => contextKey(r) === contextKey(latest));
  const eligible = matching.filter(r => generationForRecord(r, coverageType));
  const selected = limit === null ? eligible : eligible.slice(-limit);
  const intervalOutputTokens = selected.reduce((n, r) => n + r.generation.intervalOutputTokens, 0);
  const durationMs = selected.reduce((n, r) => n + r.generation.durationMs, 0);
  const outputTokens = selected.reduce((n, r) => n + r.generation.outputTokens, 0);
  const ordinaryOutputTokens = selected.reduce((n, r) => n + (r.responseMetrics?.scopes?.ordinary?.outputTokens ?? r.generation.outputTokens), 0);
  const newest = selected.at(-1);
  const turnsSinceLastSample = newest ? matching.length - 1 - matching.indexOf(newest) : null;
  const sampleAgeMs = newest && Number.isFinite(nowMs) && Number.isFinite(Date.parse(newest.capturedAt))
    ? Math.max(0, nowMs - Date.parse(newest.capturedAt)) : null;
  return { available: selected.length > 0, context: latest?.context ?? null, sampleLimit: limit,
    historyScope: "retained-session-records", coverageType,
    measuredTurns: selected.length, eligibleTurns: eligible.length, matchingTurns: matching.length,
    excludedTurns: matching.length - eligible.length, intervalOutputTokens, durationMs,
    tps: durationMs > 0 ? intervalOutputTokens / (durationMs / 1000) : null,
    latestTurnIncluded: selected.includes(latest),
    shortOutputTurns: selected.filter(r => r.generation.shortOutput).length,
    outputTokens, ordinaryOutputTokens, measuredOutputTokenFraction: ordinaryOutputTokens > 0 ? outputTokens / ordinaryOutputTokens : null,
    firstCapturedAt: selected[0]?.capturedAt ?? null, lastCapturedAt: newest?.capturedAt ?? null,
    turnsSinceLastSample, sampleAgeMs, stale: turnsSinceLastSample >= 5 || sampleAgeMs >= 60 * 60 * 1000,
    measurementVersion: 4, isPureGenerationTps: false };
}

export function summarizeStatusRecords(records, { nowMs = Date.now() } = {}) {
  const valid = (records || []).filter(
    (record) => finiteNumber(record.outputTokens) > 0 && endToEndDurationForRecord(record) !== null
  );
  const latest = valid.at(-1) || null;
  const latestGeneration = generationForRecord(latest);
  const latestPartialGeneration = generationForRecord(latest, "partial");
  const latestSample = latestGeneration || latestPartialGeneration;
  const latestNonReasoningOutputTokens = nonReasoningOutputForRecord(latest);
  const latestReasoningBreakdownAvailable = latestNonReasoningOutputTokens !== null;
  const latestUsesNonReasoning = latestReasoningBreakdownAvailable;
  const nonReasoningMeasured = valid.filter(
    (record) => nonReasoningOutputForRecord(record) !== null
  );
  const totalOutputTokens = valid.reduce((total, record) => total + record.outputTokens, 0);
  const totalDurationMs = valid.reduce(
    (total, record) => total + endToEndDurationForRecord(record),
    0
  );
  const nonReasoningOutputTokens = nonReasoningMeasured.reduce(
    (total, record) => total + nonReasoningOutputForRecord(record),
    0
  );
  const nonReasoningDurationMs = nonReasoningMeasured.reduce(
    (total, record) => total + endToEndDurationForRecord(record),
    0
  );
  const primaryRecords = latestUsesNonReasoning ? nonReasoningMeasured : valid;
  const primaryDurationMs = latestUsesNonReasoning ? nonReasoningDurationMs : totalDurationMs;
  const primaryOutputTokens = latestUsesNonReasoning
    ? nonReasoningOutputTokens
    : totalOutputTokens;
  const requestMeasured = valid.filter(hasCompleteRequestMeasurement);
  const requestOutputTokens = requestMeasured.reduce(
    (total, record) => total + estimatedNonReasoningOutputForRecord(record),
    0
  );
  const requestTotalOutputTokens = requestMeasured.reduce(
    (total, record) => total + record.estimatedOutputTokens,
    0
  );
  const requestDurationMs = requestMeasured.reduce(
    (total, record) => total + (record.requestDurationMs ?? record.inferenceDurationMs),
    0
  );
  const latestRequestDurationMs = validDurationMs(
    latest?.requestDurationMs ?? latest?.inferenceDurationMs
  );
  const latestEstimatedNonReasoningOutputTokens = estimatedNonReasoningOutputForRecord(latest);
  const latestEstimatedRequestCount = finiteNumber(latest?.estimatedRequestCount) ?? 0;
  const latestRequestCoverageComplete = latest ? hasCompleteRequestMeasurement(latest) : false;
  const latestMeanOutputTokensPerRequest =
    finiteNumber(latest?.estimatedOutputTokens) > 0 && latestEstimatedRequestCount > 0
      ? latest.estimatedOutputTokens / latestEstimatedRequestCount
      : null;
  const ttftMeasured = valid.filter((record) => {
    return validTtftForRecord(record) !== null;
  });
  const latestTtftRecord = ttftMeasured.at(-1) || null;
  const ttftTotalMs = ttftMeasured.reduce(
    (total, record) => total + validTtftForRecord(record),
    0
  );
  const latestDurationMs = endToEndDurationForRecord(latest);
  const latestCompletedDurationMs = completedDurationForRecord(latest);
  const latestTotalOutputThroughput = latest
    ? latest.outputTokens / (latestDurationMs / 1000)
    : null;
  const latestNonReasoningThroughput = latestUsesNonReasoning
    ? latestNonReasoningOutputTokens / (latestDurationMs / 1000)
    : null;
  const sessionTotalOutputThroughput =
    totalOutputTokens > 0 && totalDurationMs > 0
      ? totalOutputTokens / (totalDurationMs / 1000)
      : null;
  const sessionNonReasoningThroughput =
    nonReasoningDurationMs > 0
      ? nonReasoningOutputTokens / (nonReasoningDurationMs / 1000)
      : null;
  return {
    available: Boolean(latest),
    metric: latestUsesNonReasoning
      ? "non_reasoning_output_end_to_end_throughput"
      : "total_output_end_to_end_throughput",
    isPureGenerationTps: false,
    displayMetric: latestGeneration ? "generation_tps_estimate" : latestPartialGeneration ? "generation_tps_partial" : "generation_tps_unavailable",
    modelGroups: groupedSessionMetrics(valid),
    recentGeneration: generationComparisonMetrics(valid, latest, 5, "complete", nowMs),
    sessionGeneration: generationComparisonMetrics(valid, latest, null, "complete", nowMs),
    recentPartialGeneration: generationComparisonMetrics(valid, latest, 5, "partial", nowMs),
    sessionPartialGeneration: generationComparisonMetrics(valid, latest, null, "partial", nowMs),
    requestCoverageCompleteForThroughput: latestRequestCoverageComplete,
    // Compatibility alias: an available inferred interval includes TTFT by construction.
    requestThroughputIncludesTtft: latestRequestCoverageComplete,
    requestThroughputMethod: latestRequestCoverageComplete
      ? "transcript-heuristic-request-intervals-including-ttft"
      : null,
    turns: valid.length,
    latest: latest
      ? {
          context: latest.context ?? { model: null, provider: null, reasoningEffort: null },
          usageSource: latest.usageSource ?? "legacy_token_count",
          responseMetrics: latest.responseMetrics ?? null,
          generation: latest.generation ? { ...latest.generation, available: Boolean(latestGeneration),
            coverageComplete: Boolean(latestGeneration), tps: latestGeneration?.tps ?? null,
            sampleAvailable: Boolean(latestSample), measuredTps: latestSample?.tps ?? null,
            coverageType: latestGeneration ? "complete" : latestPartialGeneration ? "partial" : "unavailable",
            exclusionReasons: (latest.generation.available || latest.generation.sampleAvailable) && !latestSample
              ? { ...latest.generation.exclusionReasons, invalid_saved_generation_evidence: 1 }
              : latest.generation.exclusionReasons } : null,
          outputTokens: latest.outputTokens,
          reasoningTokens: reasoningOutputForRecord(latest),
          nonReasoningOutputTokens: latestNonReasoningOutputTokens,
          reasoningBreakdownAvailable: latestReasoningBreakdownAvailable,
          stopDurationMs: validDurationMs(latest.durationMs),
          durationMs: latestDurationMs,
          durationSource: latestCompletedDurationMs !== null ? "task_complete" : "stop_wall_clock",
          durationFinal: latestCompletedDurationMs !== null,
          throughput: latestUsesNonReasoning
            ? latestNonReasoningThroughput
            : latestTotalOutputThroughput,
          nonReasoningThroughput: latestNonReasoningThroughput,
          totalOutputThroughput: latestTotalOutputThroughput,
          requestThroughput:
            latestRequestCoverageComplete
              ? latestEstimatedNonReasoningOutputTokens / (latestRequestDurationMs / 1000)
              : null,
          requestIntervalTotalOutputThroughput:
            latestRequestCoverageComplete
              ? latest.estimatedOutputTokens / (latestRequestDurationMs / 1000)
              : null,
          requestCoverageComplete: latestRequestCoverageComplete,
          requestDurationMs: latestRequestDurationMs,
          estimatedOutputTokens: latest.estimatedOutputTokens ?? 0,
          estimatedReasoningTokens: latest.estimatedReasoningTokens ?? null,
          estimatedNonReasoningOutputTokens: latestEstimatedNonReasoningOutputTokens,
          estimatedRequestCount: latestEstimatedRequestCount,
          meanOutputTokensPerRequest: latestMeanOutputTokensPerRequest,
          shortResponseReference:
            latestRequestCoverageComplete &&
            latestMeanOutputTokensPerRequest !== null &&
            latestMeanOutputTokensPerRequest < SHORT_RESPONSE_TOKENS_PER_REQUEST,
          unestimatedRequestCount: latest.unestimatedRequestCount ?? 0,
          tokenCountEvents: latest.tokenCountEvents,
          duplicateTokenCountEvents: latest.duplicateTokenCountEvents ?? 0,
          toolCallCount: latest.toolCallCount,
          ttftMs: validTtftForRecord(latest),
          ttftShare:
            validTtftForRecord(latest) !== null && latestDurationMs > 0
              ? validTtftForRecord(latest) / latestDurationMs
              : null,
          completedDurationMs: latestCompletedDurationMs,
          timingSource: typeof latest.timingSource === "string" ? latest.timingSource : null,
          capturedAt: latest.capturedAt,
        }
      : null,
    session: latest
      ? {
          outputTokens: totalOutputTokens,
          reasoningTokens: nonReasoningMeasured.reduce(
            (total, record) => total + reasoningOutputForRecord(record),
            0
          ),
          nonReasoningOutputTokens,
          reasoningMeasuredTurns: nonReasoningMeasured.length,
          measuredTurns: primaryRecords.length,
          durationMs: primaryDurationMs,
          totalDurationMs,
          nonReasoningDurationMs,
          throughput: primaryOutputTokens / (primaryDurationMs / 1000),
          nonReasoningThroughput: sessionNonReasoningThroughput,
          totalOutputThroughput: sessionTotalOutputThroughput,
          requestThroughput:
            requestMeasured.length > 0 && requestDurationMs > 0
              ? requestOutputTokens / (requestDurationMs / 1000)
              : null,
          requestOutputTokens,
          requestTotalOutputTokens,
          requestDurationMs,
          requestMeasuredTurns: requestMeasured.length,
          ttftMeasuredTurns: ttftMeasured.length,
          ttftMeanMs: ttftMeasured.length ? ttftTotalMs / ttftMeasured.length : null,
        }
      : null,
    mostRecentTtft: latestTtftRecord
      ? {
          ttftMs: validTtftForRecord(latestTtftRecord),
          completedDurationMs: finiteNumber(latestTtftRecord.completedDurationMs),
          timingSource:
            typeof latestTtftRecord.timingSource === "string"
              ? latestTtftRecord.timingSource
              : null,
          isLatestTurn: latestTtftRecord === latest,
          capturedAt: latestTtftRecord.capturedAt,
        }
      : null,
  };
}

export function readSessionStatus({ dataDir, sessionId }) {
  const directory = sessionDirectory(dataDir, sessionId);
  if (!directory) return summarizeStatusRecords([]);
  return summarizeStatusRecords(readStatusRecords(directory));
}

export function recordStopMetric({ dataDir, sessionId, turnId, metric, capturedAt = new Date() }) {
  if (!metric?.available) return readSessionStatus({ dataDir, sessionId });
  const directory = sessionDirectory(dataDir, sessionId);
  const turnHash = hashId(turnId);
  if (!directory || !turnHash) return summarizeStatusRecords([]);

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const current = readStatusRecords(directory).find((record) => record.turnId === turnHash);
  const timestamp = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(capturedAt);
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  const name = `${safeTimestamp}-${turnHash}-${crypto.randomBytes(5).toString("hex")}.json`;
  const finalPath = path.join(directory, name);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  const record = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    capturedAt: current?.capturedAt ?? new Date(safeTimestamp).toISOString(),
    turnId: turnHash,
    source: metric.source,
    usageSource: metric.usageSource,
    responseMetrics: metric.responseMetrics,
    generation: metric.generation,
    context: metric.context,
    outputTokens: metric.outputTokens,
    reasoningTokens: metric.reasoningTokens,
    nonReasoningOutputTokens: metric.nonReasoningOutputTokens,
    durationMs: metric.durationMs,
    requestDurationMs: metric.requestDurationMs,
    estimatedOutputTokens: metric.estimatedOutputTokens,
    estimatedReasoningTokens: metric.estimatedReasoningTokens,
    estimatedNonReasoningOutputTokens: metric.estimatedNonReasoningOutputTokens,
    estimatedRequestCount: metric.estimatedRequestCount,
    unestimatedRequestCount: metric.unestimatedRequestCount,
    tokenCountEvents: metric.tokenCountEvents,
    duplicateTokenCountEvents: metric.duplicateTokenCountEvents,
    toolCallCount: metric.toolCallCount,
    ...preservedTiming(current),
  };
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
  pruneStatusFiles(directory);
  return readSessionStatus({ dataDir, sessionId });
}

// A later provisional Stop must not erase completion evidence, including when
// the Stop and backfill writers overlapped and produced separate atomic files.
function preservedTiming(previous, next = {}) {
  const completedDurationMs = completedDurationForRecord(next) ?? completedDurationForRecord(previous);
  const ttftMs = validTtftForRecord({
    ...next,
    durationMs: next.durationMs ?? previous?.durationMs,
    completedDurationMs,
    ttftMs: validTtftForRecord(next) ?? validTtftForRecord(previous),
  });
  if (completedDurationMs === null && ttftMs === null) return {};
  const source = completedDurationForRecord(next) !== null || validTtftForRecord(next) !== null
    ? next : previous;
  return {
    completedDurationMs,
    ttftMs,
    timingSource: source?.timingSource,
    timingCapturedAt: source?.timingCapturedAt,
  };
}

function writeReplacementStatusRecord(directory, turnHash, record, nowMs = Date.now()) {
  const name = `${nowMs}-${turnHash}-${crypto.randomBytes(5).toString("hex")}.json`;
  const finalPath = path.join(directory, name);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
  return finalPath;
}

export function backfillTurnCompletion({
  dataDir,
  sessionId,
  turnId,
  completion,
  generationMetric = null,
  timingSource = "task_complete_direct",
  capturedAt = new Date(),
}) {
  if (!completion?.available) return { updated: false, reason: completion?.reason || "unavailable" };
  const directory = sessionDirectory(dataDir, sessionId);
  const turnHash = hashId(turnId);
  if (!directory || !turnHash) return { updated: false, reason: "session_or_turn_missing" };
  const matching = readStatusRecords(directory).filter((record) => record.turnId === turnHash);
  const current = matching.at(-1);
  if (!current) return { updated: false, reason: "status_record_not_ready" };
  const refreshed = generationMetric?.available && generationMetric.outputTokens === current.outputTokens ? {
    generation: generationMetric.generation, responseMetrics: generationMetric.responseMetrics,
  } : {};
  const generationChanged = refreshed.generation && JSON.stringify(refreshed) !== JSON.stringify({
    generation: current.generation, responseMetrics: current.responseMetrics,
  });
  const nextCompletedDurationMs =
    validDurationMs(completion.completedDurationMs) ?? completedDurationForRecord(current);
  const candidateCurrentTtftMs = validTtftForRecord(current);
  const candidateCompletionTtftMs = finiteNumber(completion.ttftMs);
  const nextTtftMs =
    candidateCompletionTtftMs !== null &&
    candidateCompletionTtftMs >= 0 &&
    candidateCompletionTtftMs <= MAX_TURN_DURATION_MS &&
    (nextCompletedDurationMs === null || candidateCompletionTtftMs <= nextCompletedDurationMs)
      ? candidateCompletionTtftMs
      : candidateCurrentTtftMs;
  if (
    finiteNumber(current.ttftMs) === nextTtftMs &&
    completedDurationForRecord(current) === nextCompletedDurationMs && !generationChanged
  ) {
    return { updated: false, reason: "already_backfilled" };
  }

  const timingCapturedAt = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  const safeTimingCapturedAt = Number.isFinite(timingCapturedAt.getTime())
    ? timingCapturedAt
    : new Date();
  const replacement = { ...current };
  delete replacement.__entry;
  Object.assign(replacement, {
    ...refreshed,
    schemaVersion: STATUS_SCHEMA_VERSION,
    ttftMs: nextTtftMs,
    completedDurationMs: nextCompletedDurationMs,
    timingSource,
    timingCapturedAt: safeTimingCapturedAt.toISOString(),
  });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = writeReplacementStatusRecord(
    directory,
    turnHash,
    replacement,
    safeTimingCapturedAt.getTime()
  );
  for (const record of matching) {
    if (record.__entry?.file === finalPath) continue;
    try {
      fs.unlinkSync(record.__entry.file);
    } catch {}
  }
  pruneStatusFiles(directory);
  return { updated: true, status: readSessionStatus({ dataDir, sessionId }) };
}

export function nativeOtelReferenceFromInspection(inspection) {
  const timing = inspection?.nativeTiming;
  const tbt = timing?.serviceTbt;
  const meanTbtMs = finiteNumber(tbt?.meanMs);
  const observations = finiteNumber(tbt?.observations);
  const approximateTps = finiteNumber(timing?.approximateTpsFromServiceTbt);
  const outputTokens = finiteNumber(timing?.tokenUsage?.output?.sum);
  const turnsObserved = finiteNumber(timing?.turnE2e?.observations);
  if (
    meanTbtMs === null ||
    meanTbtMs <= 0 ||
    observations === null ||
    observations <= 0 ||
    approximateTps === null ||
    approximateTps <= 0
  ) {
    return { available: false, reason: "service_tbt_not_observed" };
  }
  return {
    available: true,
    source: "codex-native-otel-engine-timing",
    confidence: inspection?.captureIsolation?.singleTurnCandidateEligible
      ? "isolated-window-candidate"
      : "capture-aggregate",
    scope: inspection?.captureIsolation?.singleTurnCandidateEligible
      ? "isolated_single_turn_capture_unattributed_to_live_stop"
      : "capture_aggregate_unattributed",
    serviceTbtMeanMs: meanTbtMs,
    observations,
    outputTokens,
    turnsObserved,
    shortOutputReference:
      outputTokens !== null && turnsObserved !== null && turnsObserved > 0
        ? outputTokens / turnsObserved < SHORT_RESPONSE_TOKENS_PER_REQUEST
        : null,
    approximateTps,
    currentTurnAttributed: false,
    exactPerRequestTps: false,
    perRequestJoinable: Boolean(inspection?.perRequestJoinable),
    rawCaptureSensitive: Boolean(inspection?.rawCaptureSensitive),
  };
}

function compactNumber(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function compactDuration(durationMs) {
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function generationUnavailableLabel(reasons) {
  const labels = {
    tool_execution_overlaps_output: "工具执行与输出重叠",
    tool_argument_timing_unconfirmed: "工具计时未匹配",
    unconfirmed_tool_start: "缺少工具参数生成起点",
    reasoning_timing_missing: "推理计时缺失",
    reasoning_usage_unknown: "推理用量未知",
    unconfirmed_item_span: "输出计时无效",
    output_timing_missing: "输出计时缺失",
    unmatched_model_output: "输出与计时未匹配",
    output_usage_pending: "输出用量尚未配齐",
    response_scope_unknown: "响应范围未确认",
    legacy_response_identity_missing: "响应标识缺失",
    insufficient_output_tokens: "输出不足两个 token",
    invalid_saved_generation_evidence: "计时证据未通过校验",
  };
  const keys = Object.keys(reasons || {});
  if (keys.includes("invalid_saved_generation_evidence")) return labels.invalid_saved_generation_evidence;
  return keys.length ? labels[keys.find(k => labels[k])] || "计时证据不完整" : null;
}

function displayedHistory(status) {
  const partial = status?.latest?.generation?.coverageType === "partial" ||
    !status?.recentGeneration?.available && status?.recentPartialGeneration?.available;
  return { partial, recent: partial ? status?.recentPartialGeneration : status?.recentGeneration,
    session: partial ? status?.sessionPartialGeneration : status?.sessionGeneration };
}

function coverageLabel(fraction) {
  if (fraction === 1) return "100%";
  if (fraction >= 0.9995) return "<100%";
  if (fraction > 0 && fraction < 0.001) return "<0.1%";
  return `${((fraction ?? 0) * 100).toFixed(1)}%`;
}

function comparisonLabel(label, metric) {
  return metric?.available && Number.isFinite(metric.tps) && metric.measuredTurns > 0 ?
    `${label} ≈${metric.tps.toFixed(1)} tok/s（${metric.measuredTurns}轮${metric.stale ? "，旧样本" : ""}）` : `${label} 暂无有效样本`;
}

export function formatRecentGeneration(status) {
  const history = displayedHistory(status);
  const g = history.recent;
  const label = history.partial ? "近期已测同设置加权" : "近期完整同设置加权";
  if (!g?.available) return `${label}：暂无有效样本`;
  const c = g.context || {};
  return `${label}：≈${g.tps.toFixed(1)} tok/s（最近 ${g.measuredTurns} 个${history.partial ? "部分" : "完整"}计时轮次；本会话同设置已排除 ${g.excludedTurns} 轮；覆盖 ${coverageLabel(g.measuredOutputTokenFraction)}${g.stale ? "；旧样本" : ""}；${c.model || "模型未知"} / ${c.provider || "提供方未记录"} / ${c.reasoningEffort || "推理设置未知"}）`;
}

export function formatStatusDetails(status) {
  const line = formatStatusLine(status);
  if (!line) return null;
  const g = status.latest.generation;
  const coverage = [3, 4].includes(g?.measurementVersion) ? `计时覆盖：${g.measuredResponses}/${g.ordinaryResponses} 次普通响应 · 输出 token 覆盖 ${((g.measuredOutputTokenFraction ?? 0) * 100).toFixed(1)}%` : "计时覆盖：暂无新版生成计时证据";
  const reasons = Object.entries(g?.exclusionReasons || {}).map(([key, count]) => `${generationUnavailableLabel({ [key]: count })} ${count}次`).join("、");
  const complete = [comparisonLabel("近期完整", status.recentGeneration), comparisonLabel("会话完整", status.sessionGeneration)].join(" · ");
  const partial = [comparisonLabel("近期已测", status.recentPartialGeneration), comparisonLabel("会话已测", status.sessionPartialGeneration)].join(" · ");
  return [line, coverage, formatRecentGeneration(status), complete, partial, ...(reasons ? [`排除原因：${reasons}`] : [])].join("\n");
}

export function formatStatusLine(status, options = {}) {
  if (!status?.available || !status.latest || !status.session) return null;
  if (!options.verbose) {
    const g = status.latest.generation;
    const currentAvailable = g?.available && g.coverageComplete && typeof g.tps === "number" && Number.isFinite(g.tps);
    const partialAvailable = g?.sampleAvailable && g.coverageType === "partial" && Number.isFinite(g.measuredTps);
    const reason = generationUnavailableLabel(status.latest.generation?.exclusionReasons);
    const current = currentAvailable ? `本轮 ≈${g.tps.toFixed(1)} tok/s${g.shortOutput ? "（短输出）" : ""}` : partialAvailable ?
      `本轮已测 ≈${g.measuredTps.toFixed(1)} tok/s（覆盖${coverageLabel(g.measuredOutputTokenFraction)}${g.shortOutput ? "，短输出" : ""}）` :
      `本轮 暂不可测${reason ? `（${reason}）` : ""}`;
    const history = displayedHistory(status);
    const suffix = history.partial ? "已测" : "完整";
    const outputTokens = status.latest.outputTokens - (status.latest.responseMetrics?.scopes?.compaction?.outputTokens ?? 0);
    return ["⚡ 生成 TPS 估计", current, comparisonLabel(`近期${suffix}`, history.recent),
      comparisonLabel(`会话${suffix}`, history.session), `输出 ${compactNumber(outputTokens)} tok`].join(" · ");
  }
  const ttft = status.mostRecentTtft;
  const ttftSuffix = ttft
    ? ` · ${ttft.isLatestTurn ? "TTFT" : "最近有效 TTFT"} ${compactDuration(ttft.ttftMs)}`
    : "";
  const nativeOtelSuffix = status.nativeOtel?.available
    ? ` · 原生生成 TPS ≈${status.nativeOtel.approximateTps.toFixed(1)}（TBT 推算·${
        status.nativeOtel.confidence === "isolated-window-candidate" ? "单轮候选" : "捕获参考"
      }·未归轮${status.nativeOtel.shortOutputReference ? "·短输出" : ""}）`
    : "";
  if (
    status.latest.reasoningBreakdownAvailable &&
    status.latest.nonReasoningThroughput !== null &&
    status.session.nonReasoningThroughput !== null
  ) {
    return `⚡ 非推理输出吞吐 ${status.latest.nonReasoningThroughput.toFixed(1)} tok/s · 会话 ${status.session.nonReasoningThroughput.toFixed(1)} tok/s · 非推理 ${compactNumber(status.latest.nonReasoningOutputTokens)} tok · 推理 ${compactNumber(status.latest.reasoningTokens)} tok · 总输出 ${compactNumber(status.latest.outputTokens)} tok · 轮耗时 ${compactDuration(status.latest.durationMs)}${ttftSuffix}${nativeOtelSuffix}`;
  }
  if (status.latest.reasoningBreakdownAvailable) {
    return `⚡ 总输出整轮吞吐 ${status.latest.totalOutputThroughput.toFixed(1)} tok/s · 会话总输出 ${status.session.totalOutputThroughput.toFixed(1)} tok/s · 非推理 ${compactNumber(status.latest.nonReasoningOutputTokens)} tok · 推理 ${compactNumber(status.latest.reasoningTokens)} tok · 总输出 ${compactNumber(status.latest.outputTokens)} tok · 轮耗时 ${compactDuration(status.latest.durationMs)}${ttftSuffix}${nativeOtelSuffix}`;
  }
  return `⚡ 总输出整轮吞吐 ${status.latest.totalOutputThroughput.toFixed(1)} tok/s · 会话总输出 ${status.session.totalOutputThroughput.toFixed(1)} tok/s · 总输出 ${compactNumber(status.latest.outputTokens)} tok · 推理拆分缺失 · 轮耗时 ${compactDuration(status.latest.durationMs)}${ttftSuffix}${nativeOtelSuffix}`;
}

export function captureStopStatus(input, options = {}) {
  const dataDir = options.dataDir || resolvePluginDataDir(options.env);
  const capturedAt = new Date(finiteNumber(options.nowMs) ?? Date.now());
  let previousTurnBackfill = { updated: false, reason: "previous_turn_not_available" };
  try {
    const previousCompletion = extractPreviousTurnCompletion(
      input?.transcript_path,
      input?.turn_id,
      { maxTailBytes: options.maxTailBytes }
    );
    previousTurnBackfill = previousCompletion.available
      ? backfillTurnCompletion({
          dataDir,
          sessionId: input?.session_id,
          turnId: previousCompletion.turnId,
          completion: previousCompletion,
          timingSource: "task_complete_sync_recovery",
          capturedAt,
        })
      : { updated: false, reason: previousCompletion.reason };
  } catch {
    previousTurnBackfill = { updated: false, reason: "previous_turn_backfill_failed" };
  }
  const metric = extractStopMetric(input?.transcript_path, input?.turn_id, {
    nowMs: options.nowMs,
    maxTailBytes: options.maxTailBytes,
    sessionId: input?.session_id,
  });
  if (!metric.available) {
    return {
      metric,
      status: previousTurnBackfill.status || null,
      line: null,
      previousTurnBackfill,
    };
  }
  const status = recordStopMetric({
    dataDir,
    sessionId: input?.session_id,
    turnId: input?.turn_id,
    metric,
    capturedAt,
  });
  return { metric, status, line: formatStatusLine(status), previousTurnBackfill };
}
