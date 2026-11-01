// Checks the parts of M1 that talk to the desktop: the shell, the
// clipboard, document conversion, and finding
// which program holds a port. Run it inside a desktop session (CI uses xvfb-run).
//
//   node scripts/desktop-check.mjs

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "m1-desktop-"));
process.env.M1_HOME = home;
const { SHELL, run, shell } = await import("../server/core.js");
const platform = await import("../server/platform.js");

let failed = false;
async function check(what, fn) {
  try {
    const note = await fn();
    console.log(`✓ ${what}${note ? `: ${note}` : ""}`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${what}: ${e?.message ?? e}`);
  }
}
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const file = (name) => path.join(home, name);

await check("the shell tool", async () => {
  const out = await shell("echo $((6 * 7)) && echo $HOME");
  assert(out.startsWith("42\n"), JSON.stringify(out));
  return SHELL;
});

await check("the clipboard", async () => {
  const text = `m1 ${Date.now()} ✓`;
  await platform.writeClipboard(text);
  const back = (await platform.readClipboard()).trim();
  assert(back === text, `read back ${JSON.stringify(back)}`);
  return platform.copyCommand();
});

await check("documents", async () => {
  fs.writeFileSync(file("note.md"), "# Shopping\n\nApples and pears.\n");
  await run("pandoc", [file("note.md"), "-o", file("note.docx")]);
  const text = await platform.documentText(file("note.docx"));
  assert(/Apples and pears/.test(text), JSON.stringify(text));
});

await check("finding who holds a port", async () => {
  const server = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const found = await platform.listeners(server.address().port);
  server.close();
  const me = found.find((p) => p.pid === process.pid);
  assert(me && me.command.includes("desktop-check"), JSON.stringify(found));
  return `pid ${me.pid}`;
});

await check("reminder pop-ups", async () => {
  await platform.notify("M1 desktop check");
});

await check("the graphics card", async () => JSON.stringify(platform.linuxGPU()));

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
