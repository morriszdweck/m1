// Everything the agent can do. Each tool lists its parameters once; that list
// becomes the tool's entry in Spark's <tools> block.
//
// kind: "read"  only looks at things, so Approve for Me runs it without asking
//       "safe"  changes nothing outside the app (memory, reminders)
//       "write" changes something, so Auto 150M or the user must approve it

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIRS, SHELL, bus, isLocal, load, run, save, settings, shell } from "./core.js";
import { backends } from "./backends.js";
import { memory } from "./memory.js";
import { notify, openApp, openPath, readClipboard, writeClipboard } from "./platform.js";
import { guard, reachesOut, sandboxed } from "./project.js";

const HOME = os.homedir();
const UA =
  process.platform === "darwin"
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
    : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const p = (name, desc, extra = {}) => ({ name, desc, type: "string", ...extra });
const short = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const home = (f) => (f === "~" || f.startsWith("~/") ? path.join(HOME, f.slice(1)) : f);

/** Resolves ~ and paths relative to the project folder, or the workspace folder without one. */
export function expand(file, project) {
  const base = project || home(settings.workspace || HOME);
  const f = String(file ?? "").trim();
  return f ? path.resolve(base, home(f)) : base;
}

/** Resolves a path for a tool and refuses it when it's outside the chat's project. */
const at = (file, ctx) => guard(ctx?.project, expand(file, ctx?.project));

function runShell(command, ctx) {
  const root = ctx.project;
  if (!root) return shell(command, { cwd: expand(settings.workspace), signal: ctx.signal });
  const sandbox = sandboxed(root, SHELL, command);
  if (!sandbox) {
    const out = reachesOut(root, command);
    if (out) throw new Error(`${out} is outside the project folder (${tilde(root)}). I can only work inside it.`);
  }
  return shell(command, { cwd: root, signal: ctx.signal, sandbox });
}

const tilde = (f) => (f.startsWith(HOME) ? "~" + f.slice(HOME.length) : f);

function htmlText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article|header|footer)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Only public web addresses: a web page must not steer the agent into this computer's own services. */
function publicURL(raw) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("That isn't a web address.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !/^https?:$/.test(url.protocol) ||
    isLocal(url.href) ||
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(host) ||
    host.endsWith(".local") ||
    !host.includes(".")
  ) {
    throw new Error("Only public websites can be opened.");
  }
  return url.href;
}

async function bridge(action, body) {
  const res = await fetch(`${settings.browserURL}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const out = await res.json();
  if (out.error) return `error: ${out.error}`;
  return out.text ?? "";
}

async function search(query) {
  // DuckDuckGo first. It blocks quick runs of searches (an "anomaly" page), so Brave, then Bing, take over.
  let reached = false;
  for (const engine of [duckduckgo, braveSearch, bingSearch]) {
    let results = await engine(query).catch(() => null);
    // Bing sometimes searches only the first word for scripted visits ("Mouse - Wikipedia"): keep what matches the query.
    if (results && engine === bingSearch) results = results.filter((r) => relevant(r, query));
    if (results?.length) return format(results);
    if (results) reached = true;
  }
  if (!reached) throw new Error("Couldn't reach the search engine. Check the internet connection.");
  return "No results.";
}

const STOPWORDS = new Set("the and for with from that this what when where which who how are was were has have into about than then them they their there your you".split(" "));
/** True when a result mentions at least two of the query's words (or the only one). */
function relevant(result, query) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOPWORDS.has(w));
  const text = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  return words.filter((w) => text.includes(w)).length >= Math.min(2, words.length);
}

const format = (results) => results.slice(0, 6).map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");

/** Fetches a search page, retrying a dropped first connection with a short timeout. */
async function page(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...init.headers }, signal: AbortSignal.timeout(7_000) });
      return await res.text();
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
}

async function duckduckgo(query) {
  const html = await page("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }),
  });
  const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  return links.map((m, i) => {
    let url = decode(m[1]);
    const real = url.match(/uddg=([^&]+)/);
    if (real) url = decodeURIComponent(real[1]);
    return { title: htmlText(m[2]), url, snippet: snippets[i] ? htmlText(snippets[i][1]) : "" };
  });
}

async function braveSearch(query) {
  // Brave turns away Node's own HTTP client, but not curl.
  const html = await run("curl", ["-sfL", "--max-time", "10", "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9", `https://search.brave.com/search?${new URLSearchParams({ q: query })}`], { timeout: 15_000 });
  const out = [];
  for (const block of html.split('data-type="web"').slice(1)) {
    const a = block.match(/<a href="(https?:[^"]+)"/);
    const title = block.match(/search-snippet-title[^>]*>([\s\S]*?)<\/div>/);
    if (!a || !title) continue;
    const p = block.match(/class="content [^"]*"[^>]*>([\s\S]*?)<\/div>/);
    out.push({ title: htmlText(title[1]), url: decode(a[1]), snippet: p ? htmlText(p[1]) : "" });
  }
  return out;
}

async function bingSearch(query) {
  const html = await page(`https://www.bing.com/search?${new URLSearchParams({ q: query, setlang: "en" })}`, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
  const out = [];
  for (const [item] of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const a = item.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    // Bing wraps links as /ck/a?…&u=a1<base64url of the real address>.
    const wrapped = url.match(/[?&]u=a1([^&]+)/);
    if (wrapped) {
      try {
        url = Buffer.from(wrapped[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      } catch {}
    }
    const p = item.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: htmlText(a[2]), url, snippet: p ? htmlText(p[1]) : "" });
  }
  return out;
}

// ---- Reminders ----

let reminders = load("reminders.json", []);

function fireReminders() {
  const now = Date.now();
  const due = reminders.filter((r) => r.at <= now);
  if (!due.length) return;
  reminders = reminders.filter((r) => r.at > now);
  save("reminders.json", reminders);
  bus.emit("reminders", { reminders });
  for (const r of due) {
    bus.emit("notify", { title: "Reminder", body: r.text });
    notify(r.text).catch(() => {});
  }
}
setInterval(fireReminders, 15_000).unref();

export const reminderList = () => reminders;
export function cancelReminder(id) {
  reminders = reminders.filter((r) => r.id !== id);
  save("reminders.json", reminders);
  bus.emit("reminders", { reminders });
}

// ---- Tools ----

const browserRunning = () => backends.running("browser");

export const TOOLS = [
  {
    name: "shell",
    desc: `run a ${path.basename(SHELL)} command`,
    params: [p("command", "the command")],
    kind: "write",
    label: (a) => `Ran \`${short(a.command, 80)}\``,
    run: (a, ctx) => runShell(String(a.command ?? ""), ctx),
  },
  {
    name: "read_file",
    desc: "read a text file",
    params: [p("path", "file path")],
    kind: "read",
    limit: 3,
    label: (a, project) => `Read ${tilde(expand(a.path, project))}`,
    // Async, so a folder macOS is still asking about (Desktop, Documents) holds up only this step.
    async run(a, ctx) {
      const file = at(a.path, ctx);
      const stat = await fs.promises.stat(file);
      if (stat.isDirectory()) return `${tilde(file)} is a folder. Use list_dir.`;
      if (stat.size > 2_000_000) return `${tilde(file)} is too big to read (${Math.round(stat.size / 1e6)} MB).`;
      const buf = await fs.promises.readFile(file);
      if (buf.subarray(0, 4000).includes(0)) return `${tilde(file)} is not a text file.`;
      return buf.toString("utf8");
    },
  },
  {
    name: "write_file",
    desc: "create or overwrite a text file",
    params: [p("path", "file path"), p("content", "full file content")],
    kind: "write",
    label: (a, project) => `Wrote ${tilde(expand(a.path, project))}`,
    async run(a, ctx) {
      const file = at(a.path, ctx);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, String(a.content ?? ""));
      return `Saved ${tilde(file)} (${Buffer.byteLength(String(a.content ?? ""))} bytes).`;
    },
  },
  {
    name: "list_dir",
    desc: "list a folder",
    params: [p("path", "folder path", { required: false })],
    kind: "read",
    label: (a, project) => `Listed ${tilde(expand(a.path, project))}`,
    async run(a, ctx) {
      const dir = at(a.path, ctx);
      const entries = (await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith("."));
      const lines = entries.slice(0, 120).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      if (entries.length > 120) lines.push(`…and ${entries.length - 120} more`);
      return `${tilde(dir)} (${entries.length} items)\n${lines.join("\n") || "(empty)"}`;
    },
  },
  {
    name: "open",
    desc: "open an app, file or website",
    params: [p("target", "app name, path or URL")],
    kind: "write",
    label: (a) => `Opened ${short(a.target)}`,
    async run(a, ctx) {
      const target = String(a.target ?? "").trim();
      if (/^https?:\/\//i.test(target) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(target)) {
        await openPath(publicURL(target));
      } else if (fs.existsSync(expand(target, ctx.project)) || (ctx.project && /[/~]/.test(target))) {
        await openPath(at(target, ctx));
      } else {
        await openApp(target);
      }
      return `Opened ${target}.`;
    },
  },
  {
    name: "web_search",
    desc: "search the web",
    params: [p("query", "search words")],
    kind: "read",
    label: (a) => `Searched the web for “${short(a.query)}”`,
    run: (a) => search(String(a.query ?? "")),
  },
  {
    name: "fetch_url",
    desc: "read a web page as text",
    params: [p("url", "page address")],
    kind: "read",
    limit: 3,
    label: (a) => `Read ${short(String(a.url).replace(/^https?:\/\//, ""))}`,
    async run(a) {
      const res = await fetch(publicURL(String(a.url ?? "")), {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      const type = res.headers.get("content-type") ?? "";
      // PDFs, images and other binary files come back as noise that fills the context.
      if (/pdf|image|audio|video|zip|octet-stream/.test(type) || /\.pdf($|\?)/i.test(String(a.url))) {
        res.body?.cancel().catch(() => {});
        return `This link is a ${type.split(";")[0] || "binary"} file, which M1 can't read as text. Try a normal web page (HTML) instead.`;
      }
      const body = await res.text();
      if (body.startsWith("%PDF")) return "This link is a PDF, which M1 can't read as text. Try a normal web page (HTML) instead.";
      if (!type.includes("html")) return body;
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      // Skip menus and footers when the page marks its main content.
      const main = body.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0] ?? body.match(/<article[\s>][\s\S]*?<\/article>/i)?.[0] ?? body;
      return `${title ? `Title: ${htmlText(title)}\n\n` : ""}${htmlText(main)}`;
    },
  },
  {
    name: "browser_goto",
    desc: "open a page in the agent's browser",
    params: [p("url", "page address")],
    kind: "write",
    limit: 3,
    available: browserRunning,
    label: (a) => `Went to ${short(String(a.url).replace(/^https?:\/\//, ""))}`,
    run: (a) => bridge("goto", { url: publicURL(String(a.url ?? "")) }),
  },
  {
    name: "browser_read",
    desc: "read the current browser page",
    params: [],
    kind: "read",
    limit: 3,
    available: browserRunning,
    label: () => "Read the page",
    run: () => bridge("read", {}),
  },
  {
    name: "browser_click",
    desc: "click a button or link by its text",
    params: [p("target", "visible text or CSS selector")],
    kind: "write",
    limit: 3,
    available: browserRunning,
    label: (a) => `Clicked “${short(a.target)}”`,
    run: (a) => bridge("click", { target: String(a.target ?? "") }),
  },
  {
    name: "browser_type",
    desc: "type into a field",
    params: [p("target", "field label, placeholder or selector"), p("text", "what to type")],
    kind: "write",
    available: browserRunning,
    label: (a) => `Typed into “${short(a.target)}”`,
    run: (a) => bridge("type", { target: String(a.target ?? ""), text: String(a.text ?? "") }),
  },
  {
    name: "remember",
    desc: "save a lasting fact about the user",
    params: [p("fact", "short fact")],
    kind: "safe",
    label: (a) => `Remembered “${short(a.fact)}”`,
    run: (a) => (memory.add(a.fact) ? "Saved." : "Already known."),
  },
  {
    name: "recall",
    desc: "search what you know about the user",
    params: [p("query", "topic")],
    kind: "safe",
    free: true,
    label: (a) => `Recalled “${short(a.query)}”`,
    run: (a) => memory.search(String(a.query ?? ""), 8).join("\n") || "Nothing saved about that.",
  },
  {
    name: "clipboard",
    desc: "read the clipboard",
    params: [],
    kind: "read",
    label: () => "Read the clipboard",
    run: () => readClipboard(),
  },
  {
    name: "set_clipboard",
    desc: "copy text to the clipboard",
    params: [p("text", "text to copy")],
    kind: "safe",
    label: () => "Copied to the clipboard",
    run: (a) => writeClipboard(String(a.text ?? "")).then(() => "Copied."),
  },
  {
    name: "reminder",
    desc: "remind the user later",
    params: [p("text", "what to remind"), p("minutes", "minutes from now", { type: "number" })],
    kind: "safe",
    label: (a) => `Set a reminder in ${a.minutes} min`,
    run(a) {
      const minutes = Math.max(0.5, Number(a.minutes) || 10);
      const at = Date.now() + minutes * 60_000;
      reminders.push({ id: crypto.randomUUID(), text: String(a.text ?? "Reminder"), at });
      save("reminders.json", reminders);
      bus.emit("reminders", { reminders });
      return `I'll remind you at ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    },
  },
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools the model can use right now. */
export const activeTools = () => TOOLS.filter((t) => !t.available || t.available());

/** One tool as a compact JSON line, the way Spark's chat template lists tools. */
export const signature = (t) =>
  JSON.stringify({
    name: t.name,
    description: t.desc,
    parameters: {
      type: "object",
      properties: Object.fromEntries(t.params.map((x) => [x.name, { type: x.type, description: x.desc }])),
      required: t.params.filter((x) => x.required !== false).map((x) => x.name),
    },
  });

/** Runs a tool and returns text for the model, cut to the output budget. */
export async function runTool(name, args, ctx) {
  const tool = toolMap.get(name);
  if (!tool) return { ok: false, text: `Unknown tool ${name}.` };
  try {
    const out = String((await tool.run(args, ctx)) ?? "").trim() || "(no output)";
    const limit = settings.toolOutputLimit * (tool.limit ?? 1);
    return { ok: !/^(exit \d+|error:)/.test(out), text: out.length > limit ? `${out.slice(0, limit)}\n…(${out.length - limit} more characters cut)` : out };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    const cause = e?.cause?.code ?? e?.cause?.message;
    const message = e?.code === "ENOENT" ? "Not found." : `${e?.message ?? e}${cause ? ` (${cause})` : ""}`;
    return { ok: false, text: `error: ${message.slice(0, 500)}` };
  }
}
