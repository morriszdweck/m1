// Streaming client for the local llama.cpp server (OpenAI-compatible API).
// The server runs with --reasoning-format none, so Bonsai's <think> block
// arrives inside the content and M1 splits it out itself (see think.js).

import { isLocal } from "./core.js";
import { splitThink } from "./think.js";

/**
 * Streams a chat completion. Yields {content}, then {usage} and {timings} when the
 * server reports them. thinking turns Bonsai's reasoning on or off; each mode has
 * its own recommended sampling, and temperature scales from the thinking value.
 */
export async function* stream({ url, model, messages, temperature = 1.0, maxTokens = 1024, stop, thinking = true, signal }) {
  if (!isLocal(url)) throw new Error("Refusing a model address that isn't on this computer.");
  let res;
  try {
    res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: thinking ? temperature : temperature * 0.7,
        top_p: thinking ? 0.95 : 0.8,
        top_k: 20,
        min_p: 0,
        presence_penalty: thinking ? 1.0 : 1.5,
        max_tokens: maxTokens,
        stop,
        stream: true,
        stream_options: { include_usage: true },
        cache_prompt: true,
        chat_template_kwargs: { enable_thinking: thinking },
      }),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error("The model isn't answering. It may still be starting; try again in a moment.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body;
    try {
      message = JSON.parse(body).error?.message ?? body;
    } catch {}
    if (/context|exceed/i.test(message)) throw new Error("This chat got too long for the model. Start a new chat.");
    throw new Error(`The model returned an error (HTTP ${res.status}). ${message}`.slice(0, 400));
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = event.choices?.[0]?.delta;
      if (delta?.reasoning_content) yield { reasoning: delta.reasoning_content };
      if (delta?.content) yield { content: delta.content };
      if (event.usage) yield { usage: event.usage };
      if (event.timings) yield { timings: event.timings };
    }
  }
}

/** Collects a whole completion as text, without the thinking. Small jobs don't think. */
export async function complete(options) {
  let text = "";
  for await (const part of stream({ thinking: false, ...options })) if (part.content) text += part.content;
  return splitThink(text).rest.trim();
}
