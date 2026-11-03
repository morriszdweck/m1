// What M1 knows about the user: short facts kept across chats, and the idea
// cards built from them.
//
// The model sees the facts as a labeled block of saved notes, apart from the
// conversation, so it never takes a note for something said in this chat.
// Every fact passes check() first: one short plain sentence about the user,
// never the model's own commentary ("this message appears cut off…").

import { IS_MAC, MODELS, bus, load, save, settings } from "./core.js";
import { complete } from "./llm.js";

const MAX = 200;
/** Up to this many characters of facts go into every prompt whole; past it, only the relevant ones. */
const FIT = 1600;

const STOP = new Set(
  "an as at be by do in is it of on or so to up we the and for with that this from has have had are was were his her hers their they them its about into than then also just very user user's".split(" "),
);
const stem = (w) => w.replace(/'s$/, "").replace(/([^su])s$/, "$1");
const words = (s) =>
  new Set((String(s).toLowerCase().match(/[a-z0-9']{2,}/g) ?? []).map(stem).filter((w) => !STOP.has(w)));

/** How much of the smaller text the other one covers, 0 to 1. */
function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/** The same fact said again, maybe in other words or with a detail added. */
function same(a, b) {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const small = Math.min(words(a).size, words(b).size);
  return small >= 2 && overlap(a, b) >= 0.85;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const PAST =
  /^(was|were|had|did|made|went|got|grew|built|wrote|bought|became|began|took|gave|left|lost|met|ran|saw|sold|spent|taught|thought|won|found|fell|felt|kept|knew|led|paid|put|read|set|sat|stood|understood|used to|\w+ed)$/i;
const MODAL = /^(can|could|will|would|should|might|must|may)$/i;
const present = (v) =>
  /(s|sh|ch|x|z|o)$/i.test(v) ? v + "es" : /[^aeiou]y$/i.test(v) ? v.slice(0, -1) + "ies" : v + "s";

/**
 * Turns "I live in Lisbon" into "Lives in Lisbon": people (and the model, copying
 * them) write facts in the first person, but saved notes are about the user.
 * "You" in a fact is M1 itself.
 */
function thirdPerson(f) {
  f = f
    .replace(/^(I am|I'm|Im)\b/i, "Is")
    .replace(/^(I have|I've)\b/i, "Has")
    .replace(/^I (do not|don't|dont)\b/i, "Doesn't")
    .replace(/^I (cannot|can't|cant)\b/i, "Can't")
    .replace(/^I'll\b/i, "Will")
    .replace(/^I'd\b/i, "Would")
    .replace(/^I ([a-z]+)\b/i, (_, v) => cap(PAST.test(v) || MODAL.test(v) ? v : present(v)))
    .replace(/^my\b/i, "The user's")
    .replace(/\bmy\b/gi, "their")
    .replace(/\bmine\b/gi, "theirs")
    .replace(/\b(me|myself)\b/gi, "them");
  return f
    .replace(/\byou are\b|\byou're\b/gi, "M1 is")
    .replace(/\byou were\b/gi, "M1 was")
    .replace(/\byou have\b|\byou've\b/gi, "M1 has")
    .replace(/\byourself\b/gi, "M1")
    .replace(/\byour\b/gi, "M1's")
    .replace(/\byou\b/gi, "M1");
}

// The model describing the message, or itself, instead of stating a fact.
const META =
  /\b(mentioned|said|says|told|tells|asked|asks|message|appears?|seems?|cut[- ]?off|incomplete|clarif\w*|noted?|wait(ing)? for|this chat|this conversation)\b/i;
const FIRST = /\b(I|I'm|I'll|I've|I'd)\b/;

/** Cleans one fact. Returns {fact}, or {why} when it isn't a fact worth keeping. */
export function check(raw) {
  let f = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/^(fact|note|memory)\s*:\s*/i, "")
    .replace(/^(please )?(remember|note|save)( that)?\s+/i, "")
    .replace(/^that\s+/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/^(the )?user\s+(?!'s)/i, "")
    .replace(/^user's\b/i, "The user's")
    .trim();
  f = cap(thirdPerson(f));
  if (/[a-z0-9)]$/i.test(f)) f += ".";
  if (!/[a-z]{2,}/i.test(f) || f.length < 5) return { why: "it's empty." };
  if (f.length > 160) return { why: "it's too long." };
  if (/[|`#*<>{}\[\]]/.test(f)) return { why: "it has code or Markdown in it." };
  if ((f.match(/[.!?](\s|$)/g) ?? []).length > 2) return { why: "it's more than one fact." };
  if (/\?$/.test(f)) return { why: "it's a question." };
  if (FIRST.test(f)) return { why: "it says I, which isn't the user." };
  if (META.test(f)) return { why: "it describes the message instead of saying the fact." };
  return { fact: f };
}

// Facts are stored the way the Memory page shows them ("Made M1."), but a small
// model reads "The user made M1 (you)." far more reliably.
const VERB = /^(is|has|was|were|had|does|doesn't|did|can|can't|will|would|made|went|got|grew|built|wrote|\w+ed|\w+[^s]s)\b/i;
const OWNED = /^(favou?rite|name|nickname|birthday|age|job|school|wife|husband|partner|girlfriend|boyfriend|sister|brother|mom|mother|dad|father|son|daughter|kids?|children|dog|cat|pet|home|hometown|goal)\b/i;
function asNote(f) {
  const lower = f[0].toLowerCase() + f.slice(1);
  const note = VERB.test(f) ? `The user ${lower}` : OWNED.test(f) ? `The user's ${lower}` : f;
  return note.replace(/\bM1's\b/g, "your").replace(/\bM1\b/g, "you");
}
/** Notes about M1 itself ("Made M1."). The model only believes them next to its own name. */
const aboutM1 = (f) => /\bM1\b/.test(f);

function cleaned(list) {
  const out = [];
  for (const f of list) {
    const c = typeof f === "string" ? check(f) : {};
    if (c.fact && !out.some((x) => same(x, c.fact))) out.push(c.fact);
  }
  return out;
}

const stored = load("memory.json", []);
let facts = cleaned(Array.isArray(stored) ? stored : []);
let ideas = load("ideas.json", { at: 0, items: [] });

export const memory = {
  /** Drops junk that older versions saved, then rebuilds the ideas from what's left. */
  tidy() {
    if (JSON.stringify(facts) !== JSON.stringify(stored)) this.changed();
  },

  get facts() {
    return facts;
  },
  get ideas() {
    return ideas;
  },
  /** Whether every fact goes into the prompt, so there's nothing left to look up. */
  get fitsInPrompt() {
    return facts.join(" ").length <= FIT;
  },

  /**
   * Saves a fact. replaces names a saved fact this one changes ("Lives in Denver"
   * for "Lives in Austin"); the same fact in other words replaces the old wording.
   * Returns {fact, replaced}, {fact, known} or {why}.
   */
  add(raw, { replaces } = {}) {
    const c = check(raw);
    if (!c.fact) return c;
    const fact = c.fact;
    let next = facts;
    let replaced = null;
    const old = replaces ? this.find(replaces) : -1;
    if (old >= 0) {
      replaced = next[old];
      next = next.filter((_, i) => i !== old);
    }
    const dup = next.findIndex((f) => same(f, fact));
    // Said again with less detail ("Lives in Austin" after "Lives in Austin, Texas"): keep what's saved.
    const covered = dup >= 0 && [...words(fact)].every((w) => words(next[dup]).has(w));
    if (covered && !replaced) return { fact: next[dup], known: true };
    if (dup >= 0 && next[dup] === fact) {
      if (!replaced) return { fact, known: true };
    } else {
      if (dup >= 0) {
        replaced ??= next[dup];
        next = next.filter((_, i) => i !== dup);
      }
      next = [...next, fact].slice(-MAX);
    }
    facts = next;
    this.changed();
    return { fact, replaced };
  },

  /** The saved fact that best matches some words from it, or -1. Newest wins a tie. */
  find(query) {
    const q = String(query ?? "").trim();
    if (!q) return -1;
    const exact = facts.findIndex((f) => f.toLowerCase().replace(/\.$/, "") === q.toLowerCase().replace(/\.$/, ""));
    if (exact >= 0) return exact;
    const Q = words(q);
    let best = -1;
    let score = 0;
    facts.forEach((f, i) => {
      const F = words(f);
      let n = 0;
      for (const w of Q) if (F.has(w)) n++;
      const s = Q.size ? n / Q.size : 0;
      if (s >= 0.6 && s >= score) [best, score] = [i, s];
    });
    return best;
  },

  /** Deletes the fact that matches, and returns it, or null. */
  forget(query) {
    const i = this.find(query);
    if (i < 0) return null;
    const gone = facts[i];
    this.remove(i);
    return gone;
  },

  remove(index) {
    facts = facts.filter((_, i) => i !== index);
    this.changed();
  },

  /** Rewrites one fact. Returns {fact} or {why}. */
  update(index, text) {
    if (!facts[index]) return { why: "it isn't saved anymore." };
    const c = check(text);
    if (!c.fact) return c;
    facts = facts.map((f, i) => (i === index ? c.fact : f)).filter((f, i, all) => i === index || !same(f, c.fact));
    this.changed();
    return c;
  },

  clear() {
    facts = [];
    this.changed();
  },

  changed() {
    save("memory.json", facts);
    bus.emit("memory", { facts });
    clearTimeout(this.ideaTimer);
    this.ideaTimer = setTimeout(() => this.refreshIdeas().catch(() => {}), 20_000);
  },

  /** Facts that share words with the request, best first. */
  search(query, limit = 4) {
    const q = words(query);
    return facts
      .map((f, i) => ({ f, i, score: [...words(f)].filter((w) => q.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.i - a.i)
      .slice(0, limit)
      .map((x) => x.f);
  },

  /** Notes about M1 itself, worded for the "You are M1" line: " From your notes: the user made you." */
  aboutYou() {
    const mine = facts.filter(aboutM1).map((f) => {
      const n = asNote(f);
      return n[0].toLowerCase() + n.slice(1);
    });
    return mine.length ? ` From your notes: ${mine.join(" ")}` : "";
  },

  /**
   * The saved notes, for the system prompt. They're labeled as notes from past
   * chats so the model doesn't treat one as something the user just said.
   * Small memories go in whole (and stay the same between steps, so the prompt
   * cache holds); big ones send only what's relevant plus the newest few.
   */
  promptBlock(query) {
    const about = facts.filter((f) => !aboutM1(f));
    if (!about.length) return "";
    const picked = this.fitsInPrompt
      ? about
      : about.filter((f) => new Set([...this.search(query, 8), ...about.slice(-4)]).has(f));
    return [
      "## Memory",
      "Notes you saved about the user in earlier chats. They are background, not part of this conversation: the user did not say them here, so never call one a message, something they just said, or an earlier message. Use a note only when it helps with what the user asks now; otherwise don't mention it. If the user says something that disagrees with a note, believe the user.",
      ...picked.map((f) => `- ${asNote(f)}`),
      this.fitsInPrompt ? "" : "There are more notes; use recall to look one up.",
    ]
      .filter(Boolean)
      .join("\n");
  },

  /**
   * Picks up lasting facts the user mentions in passing, and changes to saved
   * ones. Runs after a reply, off the critical path. Returns what it saved.
   */
  async learnFrom(text) {
    // "Show me…" and "tell me…" are requests; look for the user talking about themself.
    if (!/\b(i|i'm|im|i've|i'd|my|mine|we|our|call me)\b/i.test(text) || text.length > 800) return [];
    const saved = facts.slice(-30);
    const out = await complete({
      url: settings.smallURL,
      model: MODELS.small.id,
      temperature: 0.3,
      maxTokens: 400,
      messages: [
        {
          role: "system",
          content: [
            "You keep a list of short facts about the user that stay true across chats: name, age, job, school, where they live, family, pets, likes and dislikes, projects, goals, and how they like answers.",
            "Read the user's message. For each lasting fact in it, write one line:",
            "ADD: <fact>",
            "CHANGE <n>: <fact>   (when it replaces saved fact n)",
            "Write facts in the third person without a name, like 'Lives in Austin.' or 'Has a dog named Rex.'.",
            "A message that asks for something can still mention a fact: save the fact. The request itself, passing feelings, and things about files, apps or websites are not facts. If there is nothing to save, reply NONE.",
            "",
            "Examples:",
            "Message: make a table of my files -> NONE",
            "Message: my laptop is slow, why? -> NONE",
            "Message: I'm a nurse, give me a meal plan -> ADD: Works as a nurse.",
            "Message: my favorite food is sushi, where should I eat? -> ADD: Favorite food is sushi.",
            "Message: i hate long answers -> ADD: Prefers short answers.",
            "Saved: 1. Lives in Austin. Message: we moved to Denver last week -> CHANGE 1: Lives in Denver.",
          ].join("\n"),
        },
        {
          role: "user",
          content: `Saved facts:\n${saved.length ? saved.map((f, i) => `${i + 1}. ${f}`).join("\n") : "(none)"}\n\nMessage: """${text}"""`,
        },
      ],
    });
    if (/^none\b/i.test(out)) return [];
    // Keep only facts grounded in what the user actually said.
    const said = words(text);
    // Short words count when the user capitalized them: names like "Mo" or "Al".
    const names = new Set((text.match(/\b[A-Z][a-z]+\b/g) ?? []).map((w) => stem(w.toLowerCase())));
    const changes = [];
    for (const line of out.split("\n").slice(0, 3)) {
      const m = line.trim().match(/^(ADD|CHANGE\s*(\d+))\s*:\s*(.+)$/i);
      if (!m) continue;
      const fact = m[3].trim();
      const grounded = [...words(fact)].some((w) => (w.length > 3 || /\d/.test(w) || names.has(w)) && said.has(w));
      if (!grounded || /^none\b/i.test(fact)) continue;
      const old = m[2] ? saved[Number(m[2]) - 1] : undefined;
      const r = this.add(fact, { replaces: old });
      if (r.fact && !r.known) changes.push(r);
    }
    return changes;
  },

  /** Builds four personalized "try this" cards from memory. */
  async refreshIdeas() {
    // With nothing known yet the app's hand-picked starters beat generic guesses.
    if (!facts.length) {
      ideas = { at: Date.now(), items: [] };
      save("ideas.json", ideas);
      bus.emit("ideas", { ideas });
      return ideas;
    }
    const known = facts.slice(-15).join(" ");
    const out = await complete({
      url: settings.smallURL,
      model: MODELS.small.id,
      temperature: 1.0,
      maxTokens: 1000,
      messages: [
        {
          role: "system",
          content: `You suggest things a personal AI agent on a ${IS_MAC ? "Mac" : "Linux computer"} could do for this user right now. It can chat, search the web, use files and apps, set reminders, and browse websites. Write exactly 4 lines, each 'Short title | the full request the user would type', like 'Tidy Downloads | Sort the files in my Downloads folder into folders by type'. No numbering, nothing else.`,
        },
        { role: "user", content: `What I know about the user: ${known}` },
      ],
    });
    const items = out
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s]+/, "").split("|").map((s) => s.trim()))
      .filter(([title, prompt]) => title && prompt && prompt.split(/\s+/).length >= 4 && !/[|`#]/.test(title + prompt))
      .slice(0, 4)
      .map(([title, prompt]) => ({ title: title.slice(0, 60), prompt: prompt.slice(0, 300) }));
    if (!items.length) return ideas;
    ideas = { at: Date.now(), items };
    save("ideas.json", ideas);
    bus.emit("ideas", { ideas });
    return ideas;
  },
};
