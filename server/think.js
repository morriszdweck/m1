// Spark thinks inside <think> … </think> before it answers. Its chat template already
// opens <think>, so the reply usually starts mid-thought and only the close tag shows.
// At Instant the template closes it instead, and the reply is all answer.

const OPEN_ANY = /^\s*(?:<think>\s*)+/;
const CLOSE_ANY = /<\/think>/;

/** Splits a reply into its thinking and the rest. While the thought is still open, all of it is thinking. */
export function splitThink(text) {
  const open = text.match(OPEN_ANY);
  const close = text.match(CLOSE_ANY);
  if (close && (!open || close.index >= open[0].length)) {
    const from = open ? open[0].length : 0;
    return { thought: text.slice(from, close.index).trim(), rest: text.slice(close.index + close[0].length).replace(/^\s+/, ""), done: true };
  }
  if (open) return { thought: text.slice(open[0].length).trim(), rest: "", done: false };
  // A tag still arriving, such as a lone "<thi", isn't shown as the answer yet.
  if (/^\s*<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/.test(text)) return { thought: "", rest: "", done: false };
  return { thought: "", rest: text, done: true };
}
