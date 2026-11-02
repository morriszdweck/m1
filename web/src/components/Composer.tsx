// The message box: text and text files, the permissions menu, reasoning effort at the
// right, dictation through Parakeet 110M, and the project chin under a new chat.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, FileText, Mic, Paperclip, ShieldCheck, ShieldQuestion, Square, X, Zap } from "lucide-react";
import { api, transcribe, upload } from "../api";
import { Mic as Microphone, wav } from "../audio/capture";
import { errorToast, go, part, toast, useStore } from "../store";
import type { ApprovalMode, Attachment, Chat, Part } from "../types";
import { touchFirst } from "../phone";
import { DEVICE, cx } from "../util";
import { EffortMenu } from "./EffortMenu";
import { ProjectPicker } from "./ProjectPicker";
import { Menu, Spinner } from "./ui";

type Pending = { key: string; name: string; uploaded?: Attachment };

/** M1 reads text, so pictures, audio and video are turned away before uploading. */
const isMedia = (file: File) => /^(image|audio|video)\//.test(file.type) || /\.(png|jpe?g|gif|webp|heic|bmp|tiff|wav|m4a|mp3|aac|aiff?|caf|flac|mp4|mov)$/i.test(file.name);

export const MODES: { value: ApprovalMode; label: string; detail: string; icon: JSX.Element }[] = [
  { value: "askAlways", label: "Ask for Approval", detail: "Asks you before every action.", icon: <ShieldQuestion size={15} /> },
  { value: "approveForMe", label: "Approve for Me", detail: "Auto 150M approves safe actions and asks about the rest.", icon: <ShieldCheck size={15} /> },
  { value: "fullAuto", label: "Full Auto", detail: "Runs everything. Risky commands still ask.", icon: <Zap size={15} /> },
];

/** Approve for Me needs Auto 150M. Says what picking it will do when Auto 150M isn't ready yet. */
export function modeNote(guardian: Part | undefined, wanted: boolean) {
  if (guardian?.status === "running") return null;
  if (wanted) return guardian?.status === "failed" ? "Auto 150M didn't finish. Pick this again to retry." : "Getting Auto 150M ready. It switches on by itself.";
  if (guardian?.status === "installed" || guardian?.status === "starting") return "Starts Auto 150M first.";
  return `Downloads Auto 150M first (${guardian?.size ?? "about 1.1 GB"}).`;
}

export function fill(text: string) {
  window.dispatchEvent(new CustomEvent("la:fill", { detail: text }));
}

export function Composer({ chat, autoFocus }: { chat?: Chat; autoFocus?: boolean }) {
  const { running, settings, parts, guardianWanted } = useStore();
  const guardian = parts.find((p) => p.id === "guardian");
  const customBrain = parts.find((p) => p.id === "small")?.custom;
  // The draft survives a reload, such as the one after the server restarts.
  const draftKey = `la:draft:${chat?.id ?? "new"}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState<null | "on" | "busy">(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const mic = useRef<{ mic: Microphone; chunks: Int16Array[]; started: number } | null>(null);
  const dictation = part(parts, "dictation");
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const busy = chat ? running.includes(chat.id) : false;

  const keepDraft = useCallback(
    (value: string) => {
      try {
        if (value) sessionStorage.setItem(draftKey, value);
        else sessionStorage.removeItem(draftKey);
      } catch {
        // Storage can be off; the draft just won't survive a reload.
      }
    },
    [draftKey],
  );
  useEffect(() => {
    if (text) keepDraft(text);
  }, [text, keepDraft]);

  // Grow the box with its content, and again whenever its width changes.
  const fit = useCallback(() => {
    const el = area.current;
    if (!el || !el.clientWidth) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);
  useLayoutEffect(fit, [text, recording, fit]);
  useEffect(() => {
    const el = area.current?.parentElement;
    if (!el) return;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, recording]);

  useEffect(() => {
    const onFill = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      requestAnimationFrame(() => area.current?.focus());
    };
    window.addEventListener("la:fill", onFill);
    return () => window.removeEventListener("la:fill", onFill);
  }, []);

  useEffect(() => {
    if (autoFocus && !touchFirst()) area.current?.focus();
  }, [autoFocus, chat?.id]);

  const addFiles = useCallback(async (list: File[]) => {
    for (const file of list) {
      if (isMedia(file)) {
        toast(`M1 reads text files and documents, not pictures or audio. ${file.name} wasn't added.`, "error");
        continue;
      }
      if (file.size > 25 * 1024 * 1024) {
        toast(`${file.name} is too big (25 MB at most).`, "error");
        continue;
      }
      const key = crypto.randomUUID();
      setFiles((f) => [...f, { key, name: file.name }]);
      try {
        const uploaded: Attachment = await upload(file, file.name);
        setFiles((f) => f.map((p) => (p.key === key ? { ...p, uploaded } : p)));
      } catch (e) {
        errorToast(e);
        setFiles((f) => f.filter((p) => p.key !== key));
      }
    }
  }, []);

  // Drop files anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  const uploading = files.some((f) => !f.uploaded);
  const canSend = !busy && !uploading && (text.trim().length > 0 || files.length > 0) && recording === null;

  async function send() {
    if (!canSend) return;
    const body = { text: text.trim(), attachments: files.map((f) => f.uploaded!.id) };
    setText("");
    setFiles([]);
    try {
      if (chat) await api("POST", `/api/chats/${chat.id}/send`, body);
      else {
        const project = useStore.getState().draftProject;
        const created = await api<Chat>("POST", "/api/chats", { ...body, project: project ?? undefined });
        useStore.setState({ draftProject: null });
        go(`#/chat/${created.id}`);
      }
      keepDraft("");
    } catch (e) {
      setText(body.text);
      errorToast(e);
    }
  }

  async function startDictation() {
    // Parakeet 110M is a small extra download, fetched the first time the mic is used.
    if (!dictation || dictation.status === "missing" || dictation.status === "failed") {
      api("POST", "/api/parts/install", { ids: ["dictation"] }).catch(errorToast);
      return toast(`Getting dictation ready (${dictation?.size ?? "about 200 MB"}). Tap the mic again once it's done.`);
    }
    if (dictation.status === "installing") return toast("Dictation is still downloading. Tap the mic again once it's done.");
    const chunks: Int16Array[] = [];
    const m = new Microphone(16000, (f) => {
      chunks.push(f.pcm);
      setLevel(f.rms);
    });
    try {
      await m.start();
    } catch {
      return toast(`I can't use the microphone. Allow it for M1 in System Settings → Privacy & Security → Microphone, or in your browser's site settings.`, "error");
    }
    mic.current = { mic: m, chunks, started: Date.now() };
    setElapsed(0);
    setRecording("on");
  }

  useEffect(() => {
    if (recording !== "on") return;
    const t = setInterval(() => setElapsed(Date.now() - (mic.current?.started ?? Date.now())), 200);
    return () => clearInterval(t);
  }, [recording]);

  // Leaving the chat mid-dictation lets go of the microphone.
  useEffect(() => () => mic.current?.mic.stop(), []);

  async function stopDictation(keep: boolean) {
    const current = mic.current;
    mic.current = null;
    current?.mic.stop();
    if (!keep || !current || current.chunks.length < 10) {
      setRecording(null);
      return;
    }
    setRecording("busy");
    try {
      const said = await transcribe(wav(current.chunks, 16000));
      if (said) setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said));
      else toast("I didn't catch that. Try again a little closer to the mic.");
    } catch (e) {
      errorToast(e);
    } finally {
      setRecording(null);
      area.current?.focus();
    }
  }

  const mode = MODES.find((m) => m.value === settings?.approvalMode) ?? MODES[0];

  return (
    <div className="composer-wrap">
      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={28} />
          <div>Drop files to add them</div>
        </div>
      )}
      <div className={cx("composer", recording && "recording")}>
        {files.length > 0 && (
          <div className="attachments">
            {files.map((f) => (
              <div key={f.key} className="attachment">
                <span className="attachment-icon">
                  <FileText size={16} />
                </span>
                <span className="attachment-name">{f.name}</span>
                {!f.uploaded && (
                  <span className="attachment-busy">
                    <Spinner size={14} />
                  </span>
                )}
                <button className="attachment-remove" onClick={() => setFiles((all) => all.filter((x) => x.key !== f.key))} aria-label={`Remove ${f.name}`}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {recording ? (
          <div className="dictation">
            <span className="rec-dot" />
            <span className="rec-time">{recording === "busy" ? "Writing it down…" : `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, "0")}`}</span>
            <div className="rec-level">
              {Array.from({ length: 28 }, (_, i) => (
                <span key={i} style={{ height: `${Math.max(3, Math.min(22, level * 400 * (0.5 + Math.abs(Math.sin(i * 1.7 + elapsed / 180)))))}px` }} />
              ))}
            </div>
            {recording === "busy" ? (
              <Spinner />
            ) : (
              <>
                <button className="round-btn ghost" onClick={() => stopDictation(false)} aria-label="Cancel dictation">
                  <X size={16} />
                </button>
                <button className="round-btn primary" onClick={() => stopDictation(true)} aria-label="Finish dictation">
                  <Check size={16} />
                </button>
              </>
            )}
          </div>
        ) : (
          <>
          <textarea
            ref={area}
            value={text}
            rows={1}
            placeholder={chat?.messages.length ? "Reply to M1…" : `Ask anything, or tell me what to do on your ${DEVICE}`}
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value) keepDraft("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
          />

          <div className="composer-row">
            <button className="round-btn ghost" onClick={() => picker.current?.click()} aria-label="Add files" title="Add text files and documents">
              <Paperclip size={17} />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Menu
              side="top"
              width={300}
              trigger={(open, toggle) => (
                <button
                  className={cx("mode-btn", "perm-btn", open && "active")}
                  onClick={toggle}
                  aria-label={`Permissions: ${mode.label}`}
                  title={guardianWanted ? "Approve for Me turns on once Auto 150M is ready" : "Permissions"}
                >
                  {guardianWanted && guardian?.status !== "failed" ? <Spinner size={14} /> : mode.icon}
                  <span>{mode.label}</span>
                </button>
              )}
              items={MODES.map((m) => ({
                label: m.label,
                icon: m.icon,
                detail:
                  (m.value === "approveForMe" && modeNote(guardian, guardianWanted)) ||
                  (m.value === "fullAuto" && customBrain && "Your own model is answering, so Auto 150M still checks each action.") ||
                  m.detail,
                checked: m.value === mode.value,
                onClick: () => api("PATCH", "/api/settings", { approvalMode: m.value }).catch(errorToast),
              }))}
            />
            <div className="composer-spacer" />
            <EffortMenu />
            <button
              className="round-btn ghost"
              onClick={startDictation}
              aria-label="Dictate"
              title={dictation?.status === "installing" ? "Dictation is downloading…" : "Dictate"}
            >
              {dictation?.status === "installing" ? <Spinner size={14} /> : <Mic size={17} />}
            </button>
            {busy ? (
              <button className="round-btn primary" onClick={() => api("POST", `/api/chats/${chat!.id}/stop`).catch(errorToast)} aria-label="Stop" title="Stop">
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button className="round-btn primary" onClick={send} disabled={!canSend} aria-label="Send" title="Send">
                {uploading ? <Spinner size={14} /> : <ArrowUp size={18} />}
              </button>
            )}
          </div>
          </>
        )}
      </div>
      {!chat && <ProjectPicker />}
    </div>
  );
}
