// The message box: text and text files, the permissions menu, the project
// picker and the reasoning effort slider.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Paperclip, ShieldCheck, ShieldQuestion, Square, X, Zap } from "lucide-react";
import { api, upload } from "../api";
import { errorToast, go, toast, useStore } from "../store";
import type { ApprovalMode, Attachment, Chat, Part } from "../types";
import { DEVICE, cx } from "../util";
import { EffortSlider } from "./EffortSlider";
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
  useLayoutEffect(fit, [text, fit]);
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
  }, [fit]);

  useEffect(() => {
    const onFill = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      requestAnimationFrame(() => area.current?.focus());
    };
    window.addEventListener("la:fill", onFill);
    return () => window.removeEventListener("la:fill", onFill);
  }, []);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
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
  const canSend = !busy && !uploading && (text.trim().length > 0 || files.length > 0);

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

  const mode = MODES.find((m) => m.value === settings?.approvalMode) ?? MODES[0];

  return (
    <div className="composer-wrap">
      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={28} />
          <div>Drop files to add them</div>
        </div>
      )}
      <div className="composer">
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
                  className={cx("mode-btn", open && "active")}
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
            <ProjectPicker chat={chat} />
            <EffortSlider />
            <div className="composer-spacer" />
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
      </div>
    </div>
  );
}
