// Builds what the brain actually sees: its own tools block and call format,
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

const argText = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/** A tool call in Spark's own format, the one its chat template writes. */
export const sparkCall = (name, args) =>
  `<tool_call>${name}${Object.entries(args ?? {})
    .map(([k, v]) => `<arg_key>${k}</arg_key><arg_value>${argText(v)}</arg_value>`)
    .join("")}</tool_call>`;

/** A tool call in SenseNova Loop's format (Qwen's), the one its chat template writes. */
export const qwenCall = (name, args) =>
  `<tool_call>\n<function=${name}>\n${Object.entries(args ?? {})
    .map(([k, v]) => `<parameter=${k}>\n${argText(v)}\n</parameter>\n`)
    .join("")}</function>\n</tool_call>`;

const callFor = (brain) => (brain === "loop" ? qwenCall : sparkCall);

function persona() {
  const name = settings.userName ? ` The user's name is ${settings.userName}.` : "";
  return `${PERSONALITIES[settings.personality] ?? ""}${name}`.trim();
}

/** The tools block exactly as the brain's chat template writes it. */
function toolsBlock(tools, brain) {
  if (brain === "loop") {
    return [
      "# Tools\n\nYou have access to the following functions:\n\n<tools>",
      ...tools.map((t) => `{"type": "function", "function": ${signature(t)}}`),
      "</tools>",
      "\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n",
      qwenCall("example_function_name", { example_parameter_1: "value_1", example_parameter_2: "This is the value for the second parameter\nthat can span\nmultiple lines" }),
      "\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>",
    ].join("\n");
  }
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

export function systemPrompt({ tools, query, project, brain = "spark", effortHint = null }) {
  // Both templates put their tools block at the top of the system turn, so M1's comes
  // first here and the prompt reads the way the brain was trained on.
  return [
    tools.length ? `${toolsBlock(tools, brain)}\n` : "",
    `You are M1, a private assistant running locally on the user's ${MACHINE}.${memory.aboutYou()} ${persona()}`.trim(),
    "Use Markdown when it helps: headings, lists, tables, fenced code blocks with a language, and $...$ or $$...$$ for math.",
    project
      ? `Now: ${now()}. Project folder: ${tilde(project)}. You can only read, write and run commands inside this folder; relative paths start there.`
      : `Now: ${now()}. Workspace: ${tilde(settings.workspace)}`,
    memory.promptBlock(query),
    tools.length ? TOOL_RULES(DEVICE) : "",
    // Last, so changing the effort keeps the rest of the prompt cached.
    effortHint ?? "",
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

/** Each step goes back as the brain wrote it: its call, then the result in a tool turn. */
function assistantWire(message, { latest, brain }) {
  const out = [];
  for (const step of message.steps ?? []) {
    if (!["done", "error", "denied"].includes(step.status)) continue;
    out.push({ role: "assistant", content: `${step.note ? step.note + "\n" : ""}${callFor(brain)(step.tool, step.args)}` });
    const result = step.status === "denied" ? "The user said no to this action. Don't retry it; tell the user." : (step.result ?? "");
    out.push({ role: "tool", content: latest || result.length <= 240 ? result : result.slice(0, 240) + "…" });
  }
  if (message.content?.trim()) out.push({ role: "assistant", content: message.content });
  return out;
}

/** Packs chat history into the token budget, newest first. The newest user turn is always kept. */
export function buildWire(messages, { system, budget = settings.contextBudget, brain = "spark" }) {
  const chunks = [];
  let used = estimate(system);
  let sawUser = false;
  let cut = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Before the newest user message is reached we are inside the current turn: keep it whole.
    const latest = !sawUser;
    const wire = m.role === "user" ? [{ role: "user", content: userWire(m, { latest }) }] : assistantWire(m, { latest, brain });
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
