import type { Chat } from "./types";

// The web UI is served to the same computer the server runs on, so the browser's platform is that computer's.
export const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);
/** How the UI names this computer. */
export const DEVICE = IS_MAC ? "Mac" : "computer";

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export function timeAgo(at: number) {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function bytes(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : `${part}`;
}

/** Groups chats the way chat apps do: pinned, today, yesterday, this week, older. */
export function groupChats(chats: Chat[]) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const groups: [string, Chat[]][] = [
    ["Pinned", []],
    ["Today", []],
    ["Yesterday", []],
    ["Previous 7 days", []],
    ["Older", []],
  ];
  for (const c of chats) {
    const g = c.pinned ? 0 : c.updatedAt >= today ? 1 : c.updatedAt >= today - 86400e3 ? 2 : c.updatedAt >= today - 7 * 86400e3 ? 3 : 4;
    groups[g][1].push(c);
  }
  return groups.filter(([, list]) => list.length);
}

export function chatMarkdown(chat: Chat) {
  const lines = [`# ${chat.title}`, ""];
  for (const m of chat.messages) {
    lines.push(m.role === "user" ? "## You" : "## M1", "");
    for (const s of m.steps ?? []) lines.push(`> ${s.label} (${s.decision ?? s.status})`);
    if (m.steps?.length) lines.push("");
    lines.push(m.content, "");
  }
  return lines.join("\n");
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

