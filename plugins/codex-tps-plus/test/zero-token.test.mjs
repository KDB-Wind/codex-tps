import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("production hooks work with network APIs, network imports and child processes denied", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tps-no-model-"));
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const loader = path.join(temporary, "deny-network.mjs");
  const preload = path.join(temporary, "deny-globals.cjs");
  fs.writeFileSync(loader, `export async function resolve(s, c, next) {
    if (/^(?:node:)?(?:https?|http2|net|tls|dgram|child_process)$/.test(s) ||
      /^(?:https?|wss?):/.test(s) || (!s.startsWith('.') && !s.startsWith('file:') && !s.startsWith('node:')))
      throw new Error('Forbidden network/process dependency: ' + s);
    return next(s, c);
  }`);
  fs.writeFileSync(preload, `globalThis.fetch = () => { throw new Error('Forbidden fetch'); };
    globalThis.WebSocket = class { constructor() { throw new Error('Forbidden WebSocket'); } };`);
  const transcript = path.join(temporary, "synthetic.jsonl");
  const base = Date.now() - 5000;
  const records = [
    { timestamp: new Date(base).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "local" } },
    { timestamp: new Date(base + 2000).toISOString(), type: "event_msg", payload: {
      type: "item_completed", thread_id: "local-session", turn_id: "local",
      item: { type: "AgentMessage", id: "local-output" }, started_at_ms: base + 1000, completed_at_ms: base + 2000,
    } },
    { timestamp: new Date(base + 2100).toISOString(), type: "token_usage_record", payload: {
      thread_id: "local-session", turn_id: "local", response_id: "local-response",
      usage: { output_tokens: 200, reasoning_output_tokens: 0 },
    } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "local", duration_ms: 3000, time_to_first_token_ms: 1000 } },
  ];
  fs.writeFileSync(transcript, records.map(JSON.stringify).join("\n") + "\n");
  const env = { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: path.join(temporary, "data"),
    TPS_PLUS_DATA_DIR: path.join(temporary, "data") };
  delete env.TPS_PROBE_DIR;
  const run = script => JSON.parse(execFileSync(process.execPath,
    ["--no-warnings", "--experimental-loader", pathToFileURL(loader).href, "--require", preload, path.join(root, "hooks", script), "Stop"], {
      input: JSON.stringify({ session_id: "local-session", turn_id: "local", transcript_path: transcript }),
      env, encoding: "utf8", windowsHide: true,
    }));
  const collector = run("collector.mjs");
  assert.deepEqual(Object.keys(collector), ["systemMessage"]);
  assert.match(collector.systemMessage, /本轮 ≈199\.0 tok\/s · 近期 ≈199\.0 tok\/s（1轮） · 会话 ≈199\.0 tok\/s（1轮）/);
  assert.deepEqual(run("backfill.mjs"), {});
  const statusRoot = path.join(env.PLUGIN_DATA, "status");
  const savedRecords = fs.readdirSync(statusRoot, { recursive: true }).filter(x => x.endsWith(".json"))
    .map(x => JSON.parse(fs.readFileSync(path.join(statusRoot, x))));
  assert.equal(savedRecords.length, 1);
  assert.equal(savedRecords[0].completedDurationMs, 3000);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json")));
  assert.equal(manifest.skills, "./skills/");
  assert.equal(fs.existsSync(path.join(root, "skills", "tps", "SKILL.md")), true);
});
