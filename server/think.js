// K2 Horizon thinks inside tags before it answers. The tag names the effort:
// <ifm|think> (high), <ifm|think_fast> (medium) or <ifm|think_faster> (low).
// The close doesn't always match the open (it may write <ifm|think_fast> … </ifm|think>),
// and the open can be missing when the chat template already added it.

// Plain <think> tags are read too, so a model added from Hugging Face still works.
const OPEN_ANY = /^\s*(?:<ifm\|think(?:_fast|_faster)?>|<think>)/;
const CLOSE_ANY = /<\/ifm\|think(?:_fast|_faster)?>|<\/think>/;

/** Splits a reply into its thinking and the rest. While the thought is still open, all of it is thinking. */
export function splitThink(text) {
  const open = text.match(OPEN_ANY);
  const close = text.match(CLOSE_ANY);
  if (close && (!open || close.index >= open[0].length)) {
    const from = open ? open[0].length : 0;
    return { thought: text.slice(from, close.index).trim(), rest: text.slice(close.index + close[0].length).replace(/^\s+/, ""), done: true };
  }
  if (open) return { thought: text.slice(open[0].length).trim(), rest: "", done: false };
  // A tag still arriving, such as a lone "<ifm|thi", isn't shown as the answer yet.
  if (/^\s*<(?:i(?:f(?:m(?:\|(?:t(?:h(?:i(?:n(?:k(?:_[a-z]*)?)?)?)?)?)?)?)?)?)?$/.test(text)) return { thought: "", rest: "", done: false };
  return { thought: "", rest: text, done: true };
}
