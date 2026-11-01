// Files the user attaches. M1 reads text: plain text and code, and documents it can turn into text.
// Pictures and audio are turned away, since M1 only reads text.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DIRS, load, save } from "./core.js";
import { documentText } from "./platform.js";

export const MAX_UPLOAD = 25 * 1024 * 1024;

const TEXT_EXT = new Set(
  "txt md markdown csv tsv json jsonl yaml yml toml xml html htm css js mjs cjs ts tsx jsx py rb go rs swift java kt c h cpp hpp cs php sh zsh bash sql log ini conf env tex srt vtt".split(" "),
);
const CONVERT_EXT = new Set(["docx", "doc", "rtf", "rtfd", "odt", "webarchive", "pages"]);
const MEDIA_EXT = new Set("png jpg jpeg gif webp heic bmp tiff wav m4a mp3 aac aiff aif caf flac mp4 mov".split(" "));

/** Thrown for pictures and audio, which M1 can't read. */
export class NotText extends Error {}

let index = load("uploads.json", {});
const persist = () => save("uploads.json", index);

const mimeFor = { pdf: "application/pdf" };

export const uploads = {
  get(id) {
    return index[id] ?? null;
  },

  file(id) {
    const u = index[id];
    return u && fs.existsSync(u.path) ? u.path : null;
  },

  async add(name, mime, body) {
    const id = crypto.randomUUID();
    const safeName = path.basename(String(name || "file")).replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (/^(image|audio|video)\//.test(mime) || MEDIA_EXT.has(ext)) throw new NotText("M1 reads text files and documents, not pictures or audio.");
    const file = path.join(DIRS.uploads, `${id}${ext ? "." + ext : ""}`);
    fs.writeFileSync(file, body);
    mime ||= mimeFor[ext] || "application/octet-stream";

    let kind = "other";
    let text;
    if (mime.startsWith("text/") || TEXT_EXT.has(ext)) {
      kind = "text";
      text = body.toString("utf8");
    } else if (CONVERT_EXT.has(ext)) {
      kind = "text";
      text = await documentText(file).catch(() => undefined);
      if (text === undefined) kind = "other";
    }
    if (text !== undefined) fs.writeFileSync(file + ".txt", text);

    index[id] = { id, name: safeName, mime, kind, size: fs.statSync(file).size, path: file, at: Date.now() };
    persist();
    return this.public(id);
  },

  /** Text content of a document attachment. */
  text(id) {
    const u = index[id];
    if (!u || u.kind !== "text") return "";
    try {
      return fs.readFileSync(u.path + ".txt", "utf8");
    } catch {
      return "";
    }
  },

  public(id) {
    const u = index[id];
    return u ? { id: u.id, name: u.name, mime: u.mime, kind: u.kind, size: u.size } : null;
  },

  remove(ids) {
    for (const id of ids) {
      const u = index[id];
      if (!u) continue;
      fs.rmSync(u.path, { force: true });
      fs.rmSync(u.path + ".txt", { force: true });
      delete index[id];
    }
    persist();
  },
};
