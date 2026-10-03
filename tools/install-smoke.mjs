#!/usr/bin/env node

// Exercise real CLI installation in a disposable CODEX_HOME. No model request,
// credentials, or user plugin state is needed. Hook inputs are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tps-install-smoke-"));
const marketplace = path.join(temporary, "marketplace");
const isolatedHome = path.join(temporary, "codex-home");
const pluginData = path.join(temporary, "plugin-data");
const env = { ...process.env, CODEX_HOME: isolatedHome, TPS_PLUS_DATA_DIR: pluginData };
for (const key of ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "CODEX_AUTH_TOKEN", "TPS_PROBE_DIR"]) delete env[key];
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const baseVersion = "0.6.0";

function removeTemporary(target) {
  assert.ok(path.resolve(target).startsWith(path.resolve(temporary) + path.sep));
  fs.rmSync(target, { recursive: true, force: true });
}

function findCli() {
  if (process.env.CODEX_CLI_EXE) return { file: path.resolve(process.env.CODEX_CLI_EXE), prefix: [] };
  if (process.env.CODEX_CLI_JS) return { file: process.execPath, prefix: [path.resolve(process.env.CODEX_CLI_JS)] };
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    for (const relative of ["node_modules/@openai/codex/bin/codex.js", "../lib/node_modules/@openai/codex/bin/codex.js"]) {
      const candidate = path.resolve(directory, relative);
      if (fs.existsSync(candidate)) return { file: process.execPath, prefix: [candidate] };
    }
  }
  throw new Error("Install a supported @openai/codex CLI, set CODEX_CLI_JS, or set CODEX_CLI_EXE");
}
const cli = findCli();
function codex(...args) {
  return execFileSync(cli.file, [...cli.prefix, ...args], {
    cwd: temporary, env, encoding: "utf8", windowsHide: true, timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function installedVersion(expected) {
  const entries = JSON.parse(codex("plugin", "list", "--json")).installed;
  const installed = entries.find((entry) => entry.pluginId === "codex-tps-plus@kdb-wind");
  assert.ok(installed?.installed && installed.enabled, "plugin must be installed and enabled");
  assert.equal(installed.version, expected);
  const installedRoot = path.join(isolatedHome, "plugins", "cache", "kdb-wind", "codex-tps-plus", expected);
  assert.ok(fs.existsSync(path.join(installedRoot, "hooks", "collector.mjs")), "installed cache missing");
  return installedRoot;
}
function install(expected) {
  const result = JSON.parse(codex("plugin", "add", "codex-tps-plus@kdb-wind", "--json"));
  assert.ok(result);
  return installedVersion(expected);
}
function hook(pluginRoot, kind, input, definitionRoot = pluginRoot) {
  const handlers = JSON.parse(fs.readFileSync(path.join(definitionRoot, "hooks", "hooks.json"))).hooks.Stop[0].hooks;
  const definition = handlers[kind === "collector" ? 0 : 1];
  const windows = process.platform === "win32";
  const command = windows ? definition.commandWindows : definition.command;
  const shell = windows
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "/bin/sh";
  const output = execFileSync(shell, windows
    ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command], {
    cwd: temporary, env: { ...env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: pluginData },
    input: JSON.stringify(input), encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  return JSON.parse(output);
}
function writeTurn(file, turnId) {
  const now = Date.now();
  const records = [
    { timestamp: new Date(now - 3000).toISOString(), payload: { type: "task_started", turn_id: turnId } },
    { timestamp: new Date(now - 500).toISOString(), payload: { type: "token_count", info: {
      last_token_usage: { output_tokens: 200, reasoning_output_tokens: 40 },
      total_token_usage: { output_tokens: 200 },
    } } },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify({ type: "event_msg", ...record })).join("\n") + "\n");
}
function writeModernTurn(file, turnId, sessionId) {
  const now = Date.now();
  const event = (payload, at) => ({ type: "event_msg", timestamp: new Date(at).toISOString(), payload });
  const records = [
    event({ type: "task_started", turn_id: turnId }, now - 5000),
    { type: "turn_context", payload: { model: "gpt-synthetic", effort: "high" } },
    event({ type: "item_completed", turn_id: turnId, thread_id: sessionId,
      item: { type: "Reasoning", id: "synthetic-reasoning" },
      started_at_ms: now - 4000, completed_at_ms: now - 3500 }, now - 3500),
    event({ type: "item_completed", turn_id: turnId, thread_id: sessionId,
      item: { type: "AgentMessage", id: "synthetic-item", content: [] },
      started_at_ms: now - 4000, completed_at_ms: now - 3000 }, now - 3000),
    { type: "token_usage_record", timestamp: new Date(now - 2800).toISOString(), payload: {
      turn_id: turnId, thread_id: sessionId, response_id: "synthetic-response",
      usage: { output_tokens: 200, reasoning_output_tokens: 40 },
    } },
    event({ type: "token_count", info: { last_token_usage: { output_tokens: 200, reasoning_output_tokens: 40 },
      total_token_usage: { output_tokens: 200 } } }, now - 2700),
    { type: "token_usage_record", timestamp: new Date(now - 2000).toISOString(), payload: {
      turn_id: turnId, thread_id: sessionId, response_id: "synthetic-compaction",
      usage: { output_tokens: 300, reasoning_output_tokens: 0 },
    } },
    { type: "compacted", payload: { message: "synthetic summary" }, timestamp: new Date(now - 1800).toISOString() },
  ];
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join("\n") + "\n");
}
function query(installedRoot, sessionId) {
  return JSON.parse(execFileSync(process.execPath,
    [path.join(installedRoot, "scripts", "status.mjs"), "--session-id", sessionId, "--json"],
    { env, encoding: "utf8", windowsHide: true }));
}

try {
  fs.mkdirSync(marketplace);
  fs.mkdirSync(isolatedHome);
  const archive = execFileSync("git", ["archive", `v${baseVersion}`, ".agents/plugins/marketplace.json", "plugins/codex-tps-plus"], { cwd: root });
  execFileSync("tar", ["-xf", "-", "-C", marketplace], { input: archive, windowsHide: true });
  codex("plugin", "marketplace", "add", marketplace, "--json");
  const oldRoot = install(baseVersion);
  const transcript = path.join(temporary, "synthetic.jsonl");
  const input = { session_id: "upgrade-smoke", turn_id: "old-turn", transcript_path: transcript };
  writeTurn(transcript, input.turn_id);
  assert.equal(typeof hook(oldRoot, "collector", input).systemMessage, "string");

  const source = path.join(marketplace, "plugins", "codex-tps-plus");
  removeTemporary(source);
  fs.cpSync(path.join(root, "plugins", "codex-tps-plus"), source, { recursive: true });
  const upgradedRoot = install(version);
  assert.equal(query(upgradedRoot, input.session_id).turns, 1, "upgrade must preserve old numeric state");
  input.turn_id = "new-turn";
  writeTurn(transcript, input.turn_id);
  assert.match(hook(upgradedRoot, "collector", input).systemMessage, /本轮 暂不可测/);
  fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: {
    type: "task_complete", turn_id: input.turn_id, duration_ms: 3500, time_to_first_token_ms: 500,
  } }) + "\n");
  assert.deepEqual(hook(upgradedRoot, "backfill", input), {});
  let status = query(upgradedRoot, input.session_id);
  assert.equal(status.turns, 2);
  assert.equal(status.latest.durationMs, 3500);
  assert.equal(status.latest.ttftMs, 500);
  hook(upgradedRoot, "collector", input);
  status = query(upgradedRoot, input.session_id);
  assert.equal(status.latest.durationMs, 3500);
  assert.equal(status.latest.ttftMs, 500);
  // A resumed session can retain the removed old root in its Hook environment.
  if (fs.existsSync(oldRoot)) removeTemporary(oldRoot);
  assert.match(hook(oldRoot, "collector", input, upgradedRoot).systemMessage, /本轮 暂不可测/);

  input.turn_id = "modern-turn";
  writeModernTurn(transcript, input.turn_id, input.session_id);
  assert.match(hook(upgradedRoot, "collector", input).systemMessage, /本轮 ≈199\.0 tok\/s · 近期完整 ≈199\.0 tok\/s（1轮） · 会话完整 ≈199\.0 tok\/s（1轮） · 输出 200 tok$/);
  status = query(upgradedRoot, input.session_id);
  assert.equal(status.latest.outputTokens, 500, "explicit and legacy mirrors must not double-count");
  assert.equal(status.latest.responseMetrics.scopes.compaction.outputTokens, 300);
  assert.equal(status.latest.generation.tps, 199);
  assert.ok(fs.existsSync(path.join(upgradedRoot, "skills", "tps", "SKILL.md")), "optional query skill restored");
  assert.equal(status.latest.context.model, "gpt-synthetic");

  input.turn_id = "partial-turn";
  writeModernTurn(transcript, input.turn_id, input.session_id);
  const partialNow = Date.now();
  fs.appendFileSync(transcript, [
    { type: "response_item", timestamp: new Date(partialNow - 500).toISOString(),
      payload: { type: "custom_tool_call", id: "raw-unmeasured", call_id: "unmeasured" } },
    { type: "token_usage_record", timestamp: new Date(partialNow - 400).toISOString(), payload: {
      turn_id: input.turn_id, thread_id: input.session_id, response_id: "unmeasured-response",
      usage: { output_tokens: 800, reasoning_output_tokens: 0 },
    } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  assert.match(hook(upgradedRoot, "collector", input).systemMessage,
    /本轮已测 ≈199\.0 tok\/s（覆盖20.0%） · 近期已测 ≈199\.0 tok\/s（1轮） · 会话已测 ≈199\.0 tok\/s（1轮） · 输出 1.0k tok$/);
  status = query(upgradedRoot, input.session_id);
  assert.equal(status.latest.generation.tps, null);
  assert.equal(status.latest.generation.measuredTps, 199);
  assert.equal(status.recentGeneration.measuredTurns, 1);
  assert.equal(status.recentPartialGeneration.measuredTurns, 1);
  assert.equal(status.latest.outputTokens, 1300);

  codex("plugin", "remove", "codex-tps-plus@kdb-wind");
  const freshRoot = install(version);
  assert.deepEqual(hook(freshRoot, "collector", {}), {});
  console.log(JSON.stringify({ ok: true, codex: codex("--version").trim(), version,
    checks: [`install-${baseVersion}`, "upgrade-to-candidate", "preserve-status", "completion-backfill",
      "repeated-stop", "removed-old-cache-fallback", "explicit-response-mirrors", "compaction-scope",
      "matched-output-speed", "partial-output-with-coverage", "separate-complete-partial-history", "clean-candidate-install"],
    modelRequests: 0 }));
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("tps-install-smoke-"));
  fs.rmSync(temporary, { recursive: true, force: true });
}
