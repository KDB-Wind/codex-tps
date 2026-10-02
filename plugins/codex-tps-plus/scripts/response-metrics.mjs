// Version-dependent rollout adapter. IDs and content stay in memory; only
// bounded numeric summaries and validated model labels leave this module.
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const OUTPUT_KINDS = new Set(["Reasoning", "AgentMessage"]);
const RAW_TOOLS = new Set(["function_call", "custom_tool_call", "local_shell_call", "mcp_tool_call", "web_search_call"]);
const TOOL_ITEMS = new Set(["CommandExecution", "McpToolCall", "DynamicToolCall", "WebSearch", "Extension"]);

function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usage(value) {
  const output = count(value?.output_tokens);
  if (output === null) return null;
  const reasoning = count(value?.reasoning_output_tokens);
  return {
    output, reasoning: reasoning !== null && reasoning <= output ? reasoning : null,
    input: count(value?.input_tokens), cached: count(value?.cached_input_tokens),
  };
}

function sameUsage(a, b) {
  return a.output === b.output && a.reasoning === b.reasoning &&
    (a.input === null || b.input === null || a.input === b.input) &&
    (a.cached === null || b.cached === null || a.cached === b.cached);
}

function matchesMirror(a, b) {
  // Legacy snapshots may omit reasoning. The explicit record owns the split;
  // missing legacy detail must not turn its mirror into an additional response.
  return sameUsage({ ...a, reasoning: a.reasoning ?? b.reasoning },
    { ...b, reasoning: b.reasoning ?? a.reasoning });
}

function label(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,96}$/.test(value) ? value : null;
}

function timestamp(record) {
  const ms = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function windowState() {
  return { firstKind: null, items: new Map(), rawCounts: new Map(), rawTimes: new Map(),
    calls: new Map(), rawIds: new Map(), emptyRawReasoning: true,
    toolEnd: null, toolStart: null, compaction: false, invalid: false };
}

function observeOutput(state, record) {
  const p = record.payload;
  if (record.type === "response_item") {
    const kind = p.type === "reasoning" ? "Reasoning" :
      p.type === "message" && p.role === "assistant" ? "AgentMessage" :
        RAW_TOOLS.has(p.type) ? "ToolArguments" : null;
    if (!kind) return;
    if (OUTPUT_KINDS.has(kind) && typeof p.id === "string") state.rawIds.set(p.id, kind);
    state.firstKind ??= kind;
    if (OUTPUT_KINDS.has(kind)) state.rawCounts.set(kind, (state.rawCounts.get(kind) || 0) + 1);
    if (kind === "Reasoning") state.emptyRawReasoning &&= Array.isArray(p.summary) && p.summary.length === 0 &&
      (p.content == null || Array.isArray(p.content) && p.content.length === 0);
    const end = timestamp(record);
    if (end === null) state.invalid = true;
    else {
      const times = state.rawTimes.get(kind);
      state.rawTimes.set(kind, { first: Math.min(times?.first ?? end, end), last: Math.max(times?.last ?? end, end) });
      if (kind === "ToolArguments") state.toolEnd = Math.max(state.toolEnd ?? end, end);
      if (kind === "ToolArguments") {
        const id = p.call_id || p.id;
        if (typeof id !== "string" || !id || state.calls.has(id)) state.invalid = true;
        else state.calls.set(id, { id, itemId: p.id, at: end });
      }
    }
    return;
  }
  if (p.type !== "item_completed") return;
  const kind = p.item?.type;
  if (!OUTPUT_KINDS.has(kind)) return;
  state.firstKind ??= kind;
  const id = p.item?.id;
  if (typeof id !== "string" || !id) { state.invalid = true; return; }
  const item = { kind, start: p.started_at_ms, end: p.completed_at_ms,
    emptyReasoning: kind === "Reasoning" && Array.isArray(p.item.summary_text) && p.item.summary_text.length === 0 &&
      Array.isArray(p.item.raw_content) && p.item.raw_content.length === 0 };
  const previous = state.items.get(id);
  if (previous && (previous.kind !== kind || previous.start !== item.start || previous.end !== item.end ||
    previous.emptyReasoning !== item.emptyReasoning)) state.invalid = true;
  state.items.set(id, item);
}

function outputWindow(state, startedAt, usageAt, responseUsage) {
  if (state.invalid) return { reason: "conflicting_or_missing_output_evidence" };
  if (state.firstKind === "ToolArguments") return { reason: "unconfirmed_tool_start" };
  const allItems = [...state.items.values()];
  // A zero-token reasoning shell is not a timed output contribution. Encrypted
  // content is opaque; the authoritative usage split must explicitly be zero.
  const ignoreReasoning = responseUsage.reasoning === 0 && state.emptyRawReasoning &&
    allItems.filter(x => x.kind === "Reasoning").every(x => x.emptyReasoning);
  const items = allItems.filter(x => !ignoreReasoning || x.kind !== "Reasoning");
  if (!items.length) return { reason: "output_timing_missing" };
  if (items.some(x => !Number.isSafeInteger(x.start) || !Number.isSafeInteger(x.end) || x.start <= 0 || x.end <= x.start)) {
    return { reason: "unconfirmed_item_span" };
  }
  const start = Math.min(...items.map(x => x.start));
  const rawTimes = [...state.rawTimes].filter(([kind]) => !ignoreReasoning || kind !== "Reasoning");
  const end = Math.max(...items.map(x => x.end), ...rawTimes.map(([, x]) => x.last));
  // Raw output with no timed counterpart must not silently contribute tokens
  // while its time is omitted. Missing paginated/legacy items cause fallback.
  if ([...state.rawIds].some(([id, kind]) => !(ignoreReasoning && kind === "Reasoning") && state.items.get(id)?.kind !== kind) ||
    [...state.rawCounts].some(([kind, n]) => !(ignoreReasoning && kind === "Reasoning") && items.filter(x => x.kind === kind).length < n) ||
    rawTimes.some(([kind, times]) => OUTPUT_KINDS.has(kind) && times.first < start)) {
    return { reason: "unmatched_model_output" };
  }
  if (responseUsage.reasoning === null) return { reason: "reasoning_usage_unknown" };
  if (responseUsage.reasoning > 0 && !items.some(x => x.kind === "Reasoning")) {
    return { reason: "reasoning_timing_missing" };
  }
  if (responseUsage.output > responseUsage.reasoning &&
    !items.some(x => x.kind === "AgentMessage") && state.toolEnd === null) {
    return { reason: "non_reasoning_timing_missing" };
  }
  if (responseUsage.output <= 1) return { reason: "insufficient_output_tokens" };
  // A call's persisted timestamp cannot replace generation timing once tool
  // execution has begun. Refuse it rather than counting tool wait as output.
  if (state.toolEnd !== null && (state.toolStart === null || state.toolEnd > state.toolStart)) {
    return { reason: "tool_argument_timing_unconfirmed" };
  }
  if (startedAt === null || usageAt === null || start < startedAt || end > usageAt || end <= start || end - start > MAX_DURATION_MS) {
    return { reason: "output_window_out_of_bounds" };
  }
  return { start, end, durationMs: end - start, reason: null };
}

// Resolve after reading the turn: execution completion can follow usage, and
// wrapper calls can contain multiple native tool items with different IDs.
function finalizeWindows(requests, tools, returns, startedAt) {
  const calls = requests.flatMap(entry => [...entry.window.calls.values()].map(call => ({ ...call, entry, returned: returns.get(call.id) })));
  for (const entry of requests) {
    const window = entry.window;
    let associationFailed = false;
    for (const call of calls.filter(x => x.entry === entry)) {
      if (returns.has(call.id) && !Number.isFinite(call.returned)) associationFailed = true;
      let matched = tools.filter(t => t.id === call.id || t.id === call.itemId);
      if (!matched.length && Number.isFinite(call.returned) && call.returned >= entry.usageAt) {
        // A native completion must lie inside a call/return envelope identified
        // by call_id. Reject cross-response envelope ambiguity, not by order.
        matched = tools.filter(t => t.recordedAt >= call.at && t.recordedAt <= call.returned);
        if (matched.some(t => calls.some(other => other.entry !== entry &&
          Number.isFinite(other.returned) && t.recordedAt >= other.at && t.recordedAt <= other.returned))) {
          associationFailed = true;
        }
      }
      if (!matched.length || matched.some(t => t.unsupported || typeof t.id !== "string" || !t.id || !Number.isFinite(t.recordedAt) ||
        !Number.isSafeInteger(t.start) || !Number.isSafeInteger(t.end) ||
        t.start < startedAt || t.end < t.start || t.end > t.recordedAt || t.end - t.start > MAX_DURATION_MS || t.conflict)) associationFailed = true;
      else window.toolStart = Math.min(window.toolStart ?? Infinity, ...matched.map(t => t.start));
    }
    if (associationFailed) window.toolStart = null;
    entry.timing = outputWindow(window, startedAt, entry.usageAt, entry.usage);
    if (!entry.timing.reason && tools.some(t => Number.isSafeInteger(t.start) && Number.isSafeInteger(t.end) &&
      t.start < entry.timing.end && t.end > entry.timing.start)) entry.timing = { reason: "tool_execution_overlaps_output" };
  }
}

export function analyzeResponseMetrics(text, currentTurnId, options = {}) {
  let active = false, foundStart = false, aborted = false, startedAt = null;
  let owner = options.sessionId || null, context = { model: null, provider: null, reasoningEffort: null };
  let pending = windowState(), requests = [], explicit = new Map(), cumulative = new Set();
  let explicitEvents = 0, duplicateResponses = 0, mirroredLegacy = 0, invalidReason = null, parseErrors = 0;
  let lastBoundary = null;
  let lastCumulativeOutput = null;
  let tools = [], toolIds = new Map(), returns = new Map(), outputOwners = new Map();
  const rows = text.split(/\r?\n/);
  for (const raw of rows) {
    if (!raw.trim()) continue;
    let r;
    try { r = JSON.parse(raw); } catch { if (active) parseErrors++; continue; }
    if (!r || typeof r !== "object" || Array.isArray(r)) { if (active) parseErrors++; continue; }
    const p = r.payload;
    if (!p || typeof p !== "object") continue;
    if (r.type === "session_meta") owner ??= p.id || null;
    if (p.thread_id && owner && p.thread_id !== owner) continue;
    const observedCumulative = p.type === "token_count" ? count(p.info?.total_token_usage?.output_tokens) : null;
    if (!active && observedCumulative !== null) lastCumulativeOutput = observedCumulative;
    if (p.type === "task_started" && typeof p.turn_id === "string") {
      active = p.turn_id === currentTurnId;
      if (active) {
        foundStart = true; aborted = false; startedAt = timestamp(r);
        if (startedAt === null && typeof p.started_at === "number") startedAt = p.started_at * 1000;
        pending = windowState(); requests = []; explicit = new Map();
        tools = []; toolIds = new Map(); returns = new Map(); outputOwners = new Map();
        cumulative = new Set(lastCumulativeOutput === null ? [] : [lastCumulativeOutput]);
        explicitEvents = 0; duplicateResponses = 0; mirroredLegacy = 0; invalidReason = null; parseErrors = 0; lastBoundary = null;
        context = { model: null, provider: null, reasoningEffort: null };
      }
      continue;
    }
    if (!active) continue;
    if (p.type === "turn_aborted" && (!p.turn_id || p.turn_id === currentTurnId)) { aborted = true; active = false; continue; }
    if (p.type === "task_complete" && (!p.turn_id || p.turn_id === currentTurnId)) { active = false; continue; }
    if (p.turn_id && p.turn_id !== currentTurnId) continue;
    if (p.thread_id) owner ??= p.thread_id;
    if (p.type === "item_completed" && p.item && !OUTPUT_KINDS.has(p.item.type) && !["UserMessage", "ContextCompaction"].includes(p.item.type)) {
      const tool = { id: p.item.id, kind: p.item.type, start: p.started_at_ms, end: p.completed_at_ms,
        recordedAt: timestamp(r), unsupported: !TOOL_ITEMS.has(p.item.type) };
      const old = toolIds.get(tool.id);
      if (old) { if (old.kind !== tool.kind || old.start !== tool.start || old.end !== tool.end) old.conflict = true; }
      else { tools.push(tool); toolIds.set(tool.id, tool); }
    }
    if (r.type === "response_item" && ["function_call_output", "custom_tool_call_output", "local_shell_call_output", "mcp_tool_call_output"].includes(p.type) && typeof p.call_id === "string") {
      const at = timestamp(r);
      if (returns.has(p.call_id) && returns.get(p.call_id) !== at) returns.set(p.call_id, NaN);
      else returns.set(p.call_id, at);
    }
    if (r.type === "turn_context") {
      context.model = label(p.model);
      context.provider = label(p.model_provider);
      context.reasoningEffort = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(p.effort ?? p.reasoning_effort) ? p.effort ?? p.reasoning_effort : null;
    }
    if (r.type === "compacted" || p.type === "item_completed" && p.item?.type === "ContextCompaction") {
      // Compaction usage is emitted before the compacted record, and has no
      // legacy mirror. Association is kept separate from normal generation.
      if (lastBoundary?.source === "explicit" && !lastBoundary.mirrored && pending.firstKind === null) lastBoundary.scope = "compaction";
      else if (pending.firstKind !== null) pending.compaction = true;
      continue;
    }
    const modelId = p.type === "item_completed" && OUTPUT_KINDS.has(p.item?.type) ? p.item.id :
      r.type === "response_item" && (p.type === "reasoning" || p.type === "message" && p.role === "assistant") ? p.id : null;
    const outputOwner = typeof modelId === "string" && modelId ? outputOwners.get(modelId) ?? pending : pending;
    observeOutput(outputOwner, r);
    if (typeof modelId === "string" && modelId) outputOwners.set(modelId, outputOwner);
    if (r.type === "token_usage_record") {
      explicitEvents++;
      if (p.turn_id !== currentTurnId || typeof p.response_id !== "string" || !p.response_id || !p.thread_id) {
        invalidReason = "explicit_usage_identity_missing"; continue;
      }
      const u = usage(p.usage);
      if (!u) { invalidReason = "explicit_usage_invalid"; continue; }
      const previous = explicit.get(p.response_id);
      if (previous) {
        duplicateResponses++;
        if (!sameUsage(previous.usage, u)) invalidReason = "conflicting_response_usage";
        continue;
      }
      let entry;
      if (lastBoundary?.source === "legacy" && pending.firstKind === null && matchesMirror(lastBoundary.usage, u)) {
        entry = lastBoundary; entry.source = "explicit"; entry.usage = u; entry.dedupAvailable = true; entry.mirrored = true;
        // The explicit split can complete evidence absent from its legacy mirror.
        entry.timing = outputWindow(entry.window, startedAt, entry.usageAt, u);
        mirroredLegacy++;
      } else {
        entry = { source: "explicit", usage: u, dedupAvailable: true, mirrored: false,
          scope: pending.compaction ? "compaction" : pending.firstKind === null ? "unclassified" : "ordinary",
          window: pending, usageAt: timestamp(r),
          timing: outputWindow(pending, startedAt, timestamp(r), u) };
        requests.push(entry);
      }
      explicit.set(p.response_id, entry);
      lastBoundary = entry; pending = windowState();
      continue;
    }
    if (p.type !== "token_count") continue;
    const u = usage(p.info?.last_token_usage);
    if (!u) continue;
    const total = count(p.info?.total_token_usage?.output_tokens);
    if (total !== null) lastCumulativeOutput = total;
    if (total !== null && cumulative.has(total)) continue;
    if (total !== null) cumulative.add(total);
    if (lastBoundary?.source === "explicit" && pending.firstKind === null && matchesMirror(lastBoundary.usage, u)) {
      lastBoundary.mirrored = true; mirroredLegacy++; continue;
    }
    if (u.output === 0) continue;
    const entry = { source: "legacy", usage: u, dedupAvailable: total !== null, mirrored: false,
      scope: pending.compaction ? "compaction" : pending.firstKind === null ? "unclassified" : "ordinary",
      timing: outputWindow(pending, startedAt, timestamp(r), u), window: pending, usageAt: timestamp(r) };
    requests.push(entry); lastBoundary = entry; pending = windowState();
  }
  finalizeWindows(requests, tools, returns, startedAt);
  const sum = key => requests.reduce((n, x) => n + x.usage[key], 0);
  const scopes = {};
  for (const scope of ["ordinary", "compaction", "unclassified"]) {
    const selected = requests.filter(x => x.scope === scope);
    scopes[scope] = { responses: selected.length, outputTokens: selected.reduce((n, x) => n + x.usage.output, 0) };
  }
  const ordinary = requests.filter(x => x.scope === "ordinary");
  const measured = ordinary.filter(x => x.source === "explicit" && !x.timing.reason);
  const reasons = {};
  for (const entry of requests.filter(x => x.scope !== "compaction")) {
    const reason = entry.scope === "unclassified" ? "response_scope_unknown" :
      entry.source === "legacy" ? "legacy_response_identity_missing" : entry.timing.reason;
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  const sorted = measured.map(x => x.timing).sort((a, b) => a.start - b.start);
  const overlaps = sorted.some((x, i) => i > 0 && x.start < sorted[i - 1].end);
  if (overlaps) reasons.overlapping_response_windows = 1;
  if (parseErrors) reasons.transcript_parse_error = parseErrors;
  if (pending.firstKind !== null) reasons.output_usage_pending = 1;
  const dedupAvailable = requests.every(x => x.dedupAvailable);
  const available = foundStart && !aborted && !invalidReason && dedupAvailable && explicit.size > 0;
  const durationMs = measured.reduce((n, x) => n + x.timing.durationMs, 0);
  const outputTokens = measured.reduce((n, x) => n + x.usage.output, 0);
  const intervalOutputTokens = measured.reduce((n, x) => n + x.usage.output - 1, 0);
  const coverageComplete = available && ordinary.length > 0 && measured.length === ordinary.length &&
    scopes.unclassified.responses === 0 && Object.keys(reasons).length === 0 && durationMs > 0;
  return {
    hasExplicitUsage: explicitEvents > 0, available, aborted,
    reason: aborted ? "turn_interrupted" : invalidReason ?? (!dedupAvailable ? "token_usage_deduplication_unavailable" : null),
    outputTokens: sum("output"), reasoningTokens: requests.every(x => x.usage.reasoning !== null) ? sum("reasoning") : null,
    usageSource: explicit.size > 0 ? requests.some(x => x.source === "legacy") ? "explicit_with_legacy_fallback" : "explicit_response_usage" : "legacy_token_count",
    responses: requests.length, duplicateResponses, mirroredLegacy, scopes, context,
    generation: { available: coverageComplete, coverageComplete, source: "matched-client-output-windows",
      measurementVersion: 3, formula: "sum(output_tokens - 1) / sum(output_window_seconds)",
      isPureGenerationTps: false, measuredResponses: measured.length, ordinaryResponses: ordinary.length,
      excludedResponses: requests.length - measured.length - scopes.compaction.responses,
      outputTokens, intervalOutputTokens, durationMs, tps: coverageComplete ? intervalOutputTokens / (durationMs / 1000) : null,
      measuredOutputTokenFraction: scopes.ordinary.outputTokens > 0 ? outputTokens / scopes.ordinary.outputTokens : 0,
      shortOutput: measured.length > 0 && outputTokens / measured.length < 128, exclusionReasons: reasons },
  };
}
