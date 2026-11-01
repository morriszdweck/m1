// Starts the server with an empty data folder and checks that its API works.
//
//   node scripts/smoke.mjs            the server, its page and the API
//   node scripts/smoke.mjs --models   also downloads the AI engine and the smallest
//                                     K2 Horizon 3.7B, then has it answer (about 2.5 GB)
//   node scripts/smoke.mjs --helpers  also installs and starts Auto 150M and the
//                                     Web helper (about 1.2 GB)
//
// Uses its own port and data folder, so a copy of M1 that is already
// running is left alone.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { ggufVariants, parseHfLink, probeGGUF } from "../server/models.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 8199);
const BASE = `http://127.0.0.1:${PORT}`;
const MODELS = process.argv.includes("--models");
const HELPERS = process.argv.includes("--helpers");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "m1-smoke-"));

let log = "";
function start() {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: { ...process.env, M1_HOME: home, M1_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("exit", (code) => fail(`the server exited with ${code}`));
  return child;
}
let server = start();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = "";

function finish(code) {
  server.kill("SIGTERM");
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(code);
}

function fail(message) {
  console.error(`✗ ${message}\n--- server output ---\n${log.slice(-4000)}`);
  for (const name of ["small.log", "guardian.log", "browser.log"]) {
    const file = path.join(home, "logs", name);
    if (fs.existsSync(file)) console.error(`--- ${name} ---\n${fs.readFileSync(file, "utf8").slice(-3000)}`);
  }
  finish(1);
}

function check(ok, message) {
  if (!ok) fail(message);
  console.log(`✓ ${message}`);
}

// ---- Hugging Face model reading (no network) ----

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const ggufString = (text) => {
  const b = Buffer.from(text);
  return Buffer.concat([u64(b.length), b]);
};
const ggufPair = (key, type, body) => Buffer.concat([ggufString(key), u32(type), body]);
const fixture = Buffer.concat([
  Buffer.from("GGUF"),
  u32(3),
  u64(0),
  u64(3),
  ggufPair("general.architecture", 8, ggufString("llama")),
  ggufPair("llama.context_length", 4, u32(8192)),
  ggufPair("tokenizer.chat_template", 8, ggufString("{{ enable_thinking }}")),
]);
const fixtureFile = path.join(home, "fixture.gguf");
fs.writeFileSync(fixtureFile, fixture);
const probe = probeGGUF(fixtureFile);
check(probe.architecture === "llama" && probe.contextLength === 8192 && probe.thinking, "it reads a GGUF header and finds its context and thinking mode");

const parsed = parseHfLink("https://huggingface.co/org/model/blob/main/dir/model-Q4_K_M.gguf");
check(parsed.repo === "org/model" && parsed.revision === "main" && parsed.file === "dir/model-Q4_K_M.gguf", "it reads a Hugging Face link to one model file");
const variants = ggufVariants(
  [
    { path: "model-Q4_K_M-00001-of-00002.gguf", size: 10 },
    { path: "model-Q4_K_M-00002-of-00002.gguf", size: 10 },
    { path: "model-Q8_0.gguf", size: 20 },
    { path: "mmproj-model.gguf", size: 5 },
  ],
  16,
);
check(variants.variants.length === 2 && variants.variants.some((v) => v.shards.length === 2), "it groups split GGUF files and skips projectors");

/** Sends raw bytes and returns the response, for uploads and audio. */
/** A plain PNG of one color, so the picture check needs no files. */
/** Waits for the last message of a chat to finish. */
const answer = (id, what) =>
  waitFor(
    what,
    (s) => {
      const last = s.chats.find((c) => c.id === id)?.messages.at(-1);
      return last?.role === "assistant" && last.status !== "streaming" && last;
    },
    10,
  );

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { "x-m1-token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json().catch(() => null);
  if (!res.ok) fail(`${method} ${route} answered ${res.status}: ${JSON.stringify(value)}`);
  return value;
}

/** Polls the state until `test` returns something truthy. */
async function waitFor(what, test, minutes) {
  const until = Date.now() + minutes * 60_000;
  let last = 0;
  while (Date.now() < until) {
    const state = await call("GET", "/api/state");
    const found = test(state);
    if (found) return found;
    const failed = state.parts.find((p) => p.status === "failed");
    if (failed) fail(`${failed.id} failed: ${failed.error}`);
    if (Date.now() - last > 30_000) {
      last = Date.now();
      console.log(`  waiting for ${what}… ${state.parts.map((p) => `${p.id}=${p.status}${p.text ? ` (${p.text})` : ""}`).join(" ")}`);
    }
    await sleep(2000);
  }
  fail(`timed out waiting for ${what}`);
}

process.on("SIGINT", () => finish(130));

async function up() {
  for (let i = 0; ; i++) {
    try {
      const health = await (await fetch(`${BASE}/healthz`)).json();
      if (health.app === "m1") break;
    } catch {}
    if (i > 60) fail("the server didn't start");
    await sleep(500);
  }
  const page = await (await fetch(BASE + "/")).text();
  token = page.match(/name="m1-token" content="([^"]+)"/)?.[1] ?? "";
}

/** Stops the server the way the app's Quit does, then starts it again on the same data. */
async function restart() {
  const old = server;
  old.removeAllListeners("exit");
  await new Promise((resolve) => {
    old.once("exit", resolve);
    old.kill("SIGTERM");
  });
  server = start();
  await up();
}

await up();
check(true, `server answers on ${BASE}`);
check(token.length > 0, "the page carries a token");

const refused = await fetch(BASE + "/api/state");
check(refused.status === 401, "the API refuses requests without the token");

const foreign = await fetch(BASE + "/api/state", { headers: { "x-m1-token": token, Origin: "https://example.com" } });
check(foreign.status === 401, "the API refuses other websites");

const state = await call("GET", "/api/state");
check(state.machine.os === process.platform, `it knows this is ${process.platform} (engine build: ${state.machine.gpu})`);
const ids = state.parts.map((p) => p.id);
check(["engine", "small", "guardian", "dictation", "browser"].every((id) => ids.includes(id)), "every part is listed");
check(state.dataDir === home, "it keeps its files in the data folder it was given");
check(state.routines.length > 0, "starter routines are there");

if (MODELS) {
  await call("PATCH", "/api/settings", { smallQuant: "Q4_K_M", reasoningEffort: "low" });
  await call("POST", "/api/parts/install", { ids: ["engine", "small"] });
  await waitFor("K2 Horizon 3.7B", (s) => s.parts.find((p) => p.id === "small" && p.status === "running"), 60);
  const engine = (await call("GET", "/api/state")).parts.find((p) => p.id === "engine");
  check(true, `K2 Horizon 3.7B runs (${engine.detail ?? "engine installed"})`);

  const chat = await call("POST", "/api/chats", { text: "Reply with one word: what color is a clear daytime sky?" });
  const reply = await answer(chat.id, "an answer");
  check(reply.status === "done" && reply.content.trim().length > 0, `K2 Horizon 3.7B answered: ${JSON.stringify(reply.content.trim().slice(0, 80))}`);
  check(reply.model === "small", "the message went to K2 Horizon 3.7B");

  // A small model doesn't always pick a tool, so this only fails when a tool it picked breaks.
  const tool = await call("POST", "/api/chats", { text: "Run this shell command and tell me what it prints: echo m1-smoke-ok" });
  const lastOf = (s) => s.chats.find((c) => c.id === tool.id)?.messages.at(-1);
  const held = await waitFor(
    "the shell tool",
    (s) => {
      const last = lastOf(s);
      return last?.steps?.find((st) => st.status === "approval") ?? (last?.role === "assistant" && last.status !== "streaming" && "no tool");
    },
    10,
  );
  if (held === "no tool") {
    console.log("- it answered without a tool this time");
  } else {
    check(held.tool === "shell", `Ask for Approval held the ${held.tool} tool`);
    await call("POST", `/api/approvals/${held.id}`, { approve: true });
    const ran = await waitFor("the command", (s) => lastOf(s)?.steps?.find((st) => st.id === held.id && ["done", "error"].includes(st.status)), 5);
    check(String(ran.result).includes("m1-smoke-ok"), `the shell tool ran the command: ${JSON.stringify(String(ran.result).trim().slice(0, 80))}`);
  }
}


if (HELPERS) {
  await call("POST", "/api/parts/install", { ids: ["guardian", "browser"] });
  const running = (s, id) => s.parts.find((p) => p.id === id && p.status === "running");
  await waitFor("Auto 150M", (s) => running(s, "guardian"), 30);
  check(true, "Auto 150M runs");
  await waitFor("the Web helper", (s) => running(s, "browser"), 30);
  check(true, "the Web helper runs");
  await call("PATCH", "/api/settings", { approvalMode: "approveForMe" });
  const mode = (await call("GET", "/api/settings")).approvalMode;
  check(mode === "approveForMe", "Approve for Me turns on");

  const marker = path.join(home, "guardian", ".ready");
  check(fs.readFileSync(marker, "utf8") === "ProCreations/auto-150m-3", "it notes which model it set up");
  // A copy set up with Auto 200M left an empty marker.
  fs.writeFileSync(marker, "");
  await restart();
  await waitFor("Auto 150M after an upgrade", (s) => running(s, "guardian"), 10);
  check(fs.readFileSync(marker, "utf8") === "ProCreations/auto-150m-3", "a copy set up with Auto 200M moves to Auto 150M");
  await waitFor("Approve for Me to come back", (s) => s.settings.approvalMode === "approveForMe", 1);
  check(true, "Approve for Me comes back on");
}

console.log("All good.");
finish(0);
