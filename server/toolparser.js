// Finds a tool call in model output. K2 Horizon writes calls in its own format:
//
//   <ifm|tool_calls>
//   <ifm|tool_call>shell
//   <ifm|arg_key>command</ifm|arg_key>
//   <ifm|arg_value>ls ~/Desktop</ifm|arg_value>
//   </ifm|tool_call>
//   </ifm|tool_calls>
//
// The stream stops at </ifm|tool_call>, so the closing tags are often missing.
// As a fallback it also reads XML-style calls (<tool_call><function=shell>…),
// a pythonic [shell(command="ls")] and JSON ({"name": "shell", "arguments": {...}}).

const MARKERS = ["<ifm|tool_calls>", "<ifm|tool_call>", "<tool_call>", "<|tool_call_start|>", "<function="];

/**
 * @param {string} text model output
 * @param {Map<string, {params: {name: string, required?: boolean}[]}>} tools known tools by name
 * @returns {{text: string, call: {name: string, args: Record<string, unknown>} | null}}
 */
export function parseToolCall(text, tools) {
  for (const find of [findIFM, findXML, findPythonic, findJSON]) {
    const found = find(text);
    if (!found) continue;
    const call = normalize(found.call, tools);
    if (call) return { text: clean(text.slice(0, found.start)), call };
  }
  return { text: clean(text), call: null };
}

/** The part of a streaming reply that is safe to show: everything before a tool call starts. */
export function visibleText(text) {
  let cut = text.length;
  for (const m of MARKERS) {
    const i = text.indexOf(m);
    if (i >= 0) cut = Math.min(cut, i);
    // Hold back a marker that is still arriving, such as a trailing "<tool".
    for (let n = Math.min(m.length - 1, text.length); n > 0; n--) {
      if (text.endsWith(m.slice(0, n))) {
        cut = Math.min(cut, text.length - n);
        break;
      }
    }
  }
  const bare = text.match(/(^|\n)\s*\[[a-z_]+\(/);
  if (bare) cut = Math.min(cut, bare.index + bare[1].length);
  return text.slice(0, cut);
}

function clean(text) {
  return text
    .replace(/<\/?ifm\|(tool_calls?|arg_key|arg_value|tools)>/g, "")
    .replace(/<\|?\/?tool_call(_start|_end)?\|?>/g, "")
    .replace(/<\/?function[^>]*>|<\/?parameter[^>]*>/g, "")
    .trim();
}

function findIFM(text) {
  const call = text.match(/<ifm\|tool_call>\s*([^\n<]+?)\s*(?=\n|<ifm\|arg_key>|<\/ifm\|tool_call>|$)/);
  if (!call) return null;
  const open = text.lastIndexOf("<ifm|tool_calls>", call.index);
  const start = open >= 0 && text.slice(open + 16, call.index).trim() === "" ? open : call.index;
  const end = text.indexOf("</ifm|tool_call>", call.index);
  const body = text.slice(call.index + call[0].length, end >= 0 ? end : undefined);
  const args = {};
  const re = /<ifm\|arg_key>([\s\S]*?)<\/ifm\|arg_key>\s*<ifm\|arg_value>([\s\S]*?)(?:<\/ifm\|arg_value>|(?=<ifm\|arg_key>)|$)/g;
  for (const m of body.matchAll(re)) args[m[1].trim()] = ifmValue(m[2]);
  return { start, call: { name: call[1].trim(), args } };
}

/** Values are plain text, or JSON for numbers, lists and objects. */
function ifmValue(raw) {
  const v = raw.replace(/^\n|\n$/g, "");
  if (/^\s*[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return coerce(v);
}

function findXML(text) {
  const fn = text.match(/<function=([^>\n]+)>/);
  if (!fn) return null;
  const open = text.lastIndexOf("<tool_call>", fn.index);
  const start = open >= 0 && text.slice(open + 11, fn.index).trim() === "" ? open : fn.index;
  const body = text.slice(fn.index + fn[0].length);
  const args = {};
  const re = /<parameter=([^>\n]+)>\n?([\s\S]*?)(?=<\/parameter>|<parameter=|<\/function>|<\/tool_call>|$)/g;
  for (const m of body.matchAll(re)) {
    args[m[1].trim()] = coerce(m[2].replace(/\n$/, ""));
  }
  return { start, call: { name: fn[1].trim(), args } };
}

function findPythonic(text) {
  const m = text.match(/(<\|tool_call_start\|>\s*)?\[\s*([A-Za-z_][\w.]*)\s*\(/);
  if (!m) return null;
  const argsStart = m.index + m[0].length;
  const args = parseKwargs(text, argsStart);
  if (!args) return null;
  return { start: m.index, call: { name: m[2], args } };
}

/** Parses `a="x", b=2)` starting at `i`. Returns null if it isn't well formed. */
function parseKwargs(text, i) {
  const args = {};
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  skip();
  if (text[i] === ")") return args;
  while (i < text.length) {
    skip();
    const key = text.slice(i).match(/^([A-Za-z_]\w*)\s*=\s*/);
    if (!key) return Object.keys(args).length ? args : null;
    i += key[0].length;
    let value;
    if (text[i] === '"' || text[i] === "'") {
      const triple = text.startsWith(text[i].repeat(3), i);
      const quote = triple ? text[i].repeat(3) : text[i];
      i += quote.length;
      let out = "";
      while (i < text.length && !text.startsWith(quote, i)) {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1];
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else out += text[i++];
      }
      i += quote.length;
      value = out;
    } else {
      const raw = text.slice(i).match(/^[^,)]*/)[0];
      i += raw.length;
      value = coerce(raw.trim());
    }
    args[key[1]] = value;
    skip();
    if (text[i] === ",") i++;
    else if (text[i] === ")") return args;
    else return args; // cut off by a stop string; keep what we have
  }
  return args;
}

function findJSON(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const obj = JSON.parse(text.slice(start, i + 1));
        const name = obj.name ?? obj.function?.name ?? obj.tool;
        let args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.function?.arguments ?? {};
        if (typeof args === "string") args = JSON.parse(args);
        if (typeof name === "string") {
          const open = text.lastIndexOf("<tool_call>", start);
          return { start: open >= 0 && text.slice(open + 11, start).trim() === "" ? open : start, call: { name, args } };
        }
      } catch {}
      return null;
    }
  }
  return null;
}

function coerce(value) {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(true|True)$/.test(v)) return true;
  if (/^(false|False)$/.test(v)) return false;
  if (/^(None|null)$/.test(v)) return null;
  return value;
}

/** Fixes the small slips a small model makes: `shell(` as a name, or one misnamed argument. */
function normalize(call, tools) {
  let name = String(call.name).split("(")[0].trim().toLowerCase();
  if (name.startsWith("functions.")) name = name.slice(10);
  const tool = tools.get(name);
  if (!tool) return null;
  const args = { ...(call.args ?? {}) };
  const known = new Set(tool.params.map((p) => p.name));
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  const missing = tool.params.filter((p) => p.required !== false && !(p.name in args));
  if (unknown.length === 1 && missing.length === 1) {
    args[missing[0].name] = args[unknown[0]];
    delete args[unknown[0]];
  }
  for (const k of Object.keys(args)) if (!known.has(k)) delete args[k];
  return { name, args };
}
