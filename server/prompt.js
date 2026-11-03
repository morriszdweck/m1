// Builds what Spark actually sees: its own tools block and call format,
// tool results in tool turns, saved memory as a labeled block apart from the
// chat, and history packed newest-first into a budget.

import os from "node:os";
import { DEVICE, IS_MAC, PERSONALITIES, settings } from "./core.js";
import { memory } from "./memory.js";
import { signature } from "./tools.js";
import { uploads } from "./uploads.js";

/** Telling the model it's on Linux keeps its shell commands right for this computer. */
const MACHINE = IS_MAC ? "Mac" : "Linux computer";

const HOME = os.homedir();
const tilde = (f) => (f.startsWith(HOME) ? "~" + f.slice(HOME.length) : f);
const now = () =>
  new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** A tool call in Spark's own format, the one its chat template writes. */
export const sparkCall = (name, args) =>
  `<tool_call>${name}${Object.entries(args ?? {})
    .map(([k, v]) => `<arg_key>${k}</arg_key><arg_value>${typeof v === "string" ? v : JSON.stringify(v)}</arg_value>`)
    .join("")}</tool_call>`;

function persona() {
  const name = settings.userName ? ` The user's name is ${settings.userName}.` : "";
  return `${PERSONALITIES[settings.personality] ?? ""}${name}`.trim();
}

/** The tools block exactly as Spark's chat template writes it, then M1's rules for using it. */
function toolsBlock(tools) {
  return [
    "## Tools",
    "You have access to the following functions:",
    "<tools>",
    ...tools.map(signature),
    "</tools>",
  ].join("\n");
}

const TOOL_RULES = (device) =>
  `Call one function at a time, then wait for its result. Answer chat, math, writing, code and knowledge questions yourself; call a function only when the request needs the ${device}, files, the web or memory. Questions about this conversation need no function. After a result, answer as soon as you know enough. When the user asks you to remember something, save it with remember as a fact about them ("remember that I made you" → "Made M1."). Also use remember when they tell you a lasting fact about themself, and forget when they ask you to forget something.`;

export function systemPrompt({ tools, query, project }) {
  // Spark's template puts its own tools block right after its built-in system line,
  // so M1's comes first here and the prompt reads the way Spark was trained on.
  return [
    tools.length ? `${toolsBlock(tools)}\n` : "",
    `You are M1, a private assistant running locally on the user's ${MACHINE}.${memory.aboutYou()} ${persona()}`.trim(),
    "Use Markdown when it helps: headings, lists, tables, fenced code blocks with a language, and $...$ or $$...$$ for math.",
    project
      ? `Now: ${now()}. Project folder: ${tilde(project)}. You can only read, write and run commands inside this folder; relative paths start there.`
      : `Now: ${now()}. Workspace: ${tilde(settings.workspace)}`,
    memory.promptBlock(query),
    tools.length ? TOOL_RULES(DEVICE) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- History packing ----

const estimate = (content) => Math.ceil(String(content).length / 4);

function userWire(message, { latest }) {
  let text = message.content ?? "";
  for (const a of message.attachments ?? []) {
    if (a.kind === "text") {
      const body = uploads.text(a.id);
      const cap = latest ? 8000 : 600;
      text += `\n\n[File: ${a.name}]\n${body.length > cap ? body.slice(0, cap) + "\n…(cut)" : body}`;
    } else {
      text += `\n[file: ${a.name}]`;
    }
  }
  return text;
}

/** Each step goes back as Spark wrote it: its call, then the result in a tool turn. */
function assistantWire(message, { latest }) {
  const out = [];
  for (const step of message.steps ?? []) {
    if (!["done", "error", "denied"].includes(step.status)) continue;
    out.push({ role: "assistant", content: `${step.note ? step.note + "\n" : ""}${sparkCall(step.tool, step.args)}` });
    const result = step.status === "denied" ? "The user said no to this action. Don't retry it; tell the user." : (step.result ?? "");
    out.push({ role: "tool", content: latest || result.length <= 240 ? result : result.slice(0, 240) + "…" });
  }
  if (message.content?.trim()) out.push({ role: "assistant", content: message.content });
  return out;
}

/** Packs chat history into the token budget, newest first. The newest user turn is always kept. */
export function buildWire(messages, { system, budget = settings.contextBudget }) {
  const chunks = [];
  let used = estimate(system);
  let sawUser = false;
  let cut = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Before the newest user message is reached we are inside the current turn: keep it whole.
    const latest = !sawUser;
    const wire = m.role === "user" ? [{ role: "user", content: userWire(m, { latest }) }] : assistantWire(m, { latest });
    const cost = wire.reduce((n, w) => n + estimate(w.content), 0);
    if (sawUser && used + cost > budget) {
      cut = true;
      break;
    }
    used += cost;
    chunks.unshift(...wire);
    if (m.role === "user") sawUser = true;
  }
  while (chunks.length && chunks[0].role !== "user") {
    chunks.shift();
    cut = true;
  }
  // Without this the model takes the first message it can see for the start of the chat.
  if (cut) system += "\nThe start of this chat is hidden to save room. If the user refers to something you can't see, ask them about it.";
  return [{ role: "system", content: system }, ...mergeSameRole(chunks)];
}

/** Joins back-to-back turns of the same role, except tool results, which stay one per call. */
function mergeSameRole(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== "tool") last.content = `${last.content}\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}
