// Bonsai thinks inside <think> … </think> before it answers. With Thinking off its
// chat template writes an empty <think></think>, and the open tag can be missing
// when the template already added it.

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
