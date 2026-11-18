// Reasoning effort, at the right of the message box. With Spark the button names the level
// and clicking it opens a small slider: Instant (no thinking), Medium and High. SenseNova Loop
// has two levels, so it gets a Think toggle instead: on is Medium, off is Instant.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Lightbulb } from "lucide-react";
import { api } from "../api";
import { errorToast, useStore } from "../store";
import type { ReasoningEffort } from "../types";
import { cx } from "../util";
import { Menu } from "./ui";

/** Space at each end of the track, so the thumb sits inside it at both ends. */
const PAD = 20;
const at = (i: number, last: number) => `calc(${PAD}px + (100% - ${2 * PAD}px) * ${i / last})`;

const LABELS: Record<ReasoningEffort, string> = { instant: "Instant", medium: "Medium", high: "High" };
const SPARK: ReasoningEffort[] = ["instant", "medium", "high"];

/** The stop a saved effort shows as when this brain doesn't have it. */
function stopFor(levels: ReasoningEffort[], saved: ReasoningEffort) {
  if (levels.includes(saved)) return saved;
  return levels.includes("medium") ? "medium" : levels[0];
}

export function EffortMenu() {
  const saved = useStore((s) => s.settings?.reasoningEffort) ?? "medium";
  const efforts = useStore((s) => s.parts.find((p) => p.id === "small")?.efforts);
  if (efforts?.length === 2) return <ThinkToggle off={efforts[0]} on={efforts[1]} saved={saved} />;
  const LEVELS = (efforts?.length ? efforts : SPARK).map((value) => ({ value, label: LABELS[value] }));
  const index = Math.max(0, LEVELS.findIndex((l) => l.value === stopFor(LEVELS.map((l) => l.value), saved)));

  return (
    <Menu
      side="top"
      align="right"
      width={260}
      trigger={(open, toggle) => (
        <button className={cx("mode-btn", open && "active")} onClick={toggle} aria-label={`Reasoning effort: ${LEVELS[index].label}`} title="Reasoning effort">
          <span>{LEVELS[index].label}</span>
        </button>
      )}
      items={() => <EffortSlider index={index} levels={LEVELS} />}
    />
  );
}

/** Thinking on or off. Anything but the off level counts as on (a saved High is Medium here). */
function ThinkToggle({ off, on, saved }: { off: ReasoningEffort; on: ReasoningEffort; saved: ReasoningEffort }) {
  const [pending, setPending] = useState<boolean | null>(null);
  // The saved setting comes back from the server; until then the button shows the new state.
  useEffect(() => {
    setPending(null);
  }, [saved]);
  const thinking = pending ?? saved !== off;

  function flip() {
    const next = !thinking;
    setPending(next);
    api("PATCH", "/api/settings", { reasoningEffort: next ? on : off }).catch((e) => {
      setPending(null);
      errorToast(e);
    });
  }

  return (
    <button
      type="button"
      className={cx("mode-btn think-btn", thinking && "on")}
      onClick={flip}
      aria-pressed={thinking}
      aria-label="Think before answering"
      title={thinking ? "Thinking is on: it reasons before it answers" : "Thinking is off: it answers right away"}
    >
      <Lightbulb size={16} strokeWidth={2} />
      <span>Think</span>
    </button>
  );
}

function EffortSlider({ index, levels: LEVELS }: { index: number; levels: { value: ReasoningEffort; label: string }[] }) {
  const [shown, setShown] = useState(index);
  const track = useRef<HTMLDivElement>(null);
  const last = LEVELS.length - 1;

  function pick(next: number) {
    next = Math.min(last, Math.max(0, next));
    setShown(next);
    if (next === index) return;
    api("PATCH", "/api/settings", { reasoningEffort: LEVELS[next].value }).catch((e) => {
      setShown(index);
      errorToast(e);
    });
  }

  // The thumb follows the pointer stop by stop, and the level is saved when it's let go.
  const stopAt = (e: PointerEvent) => {
    const box = track.current!.getBoundingClientRect();
    return Math.round(((e.clientX - box.left - PAD) / (box.width - 2 * PAD)) * last);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") pick(shown - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") pick(shown + 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="effort-pop">
      <div className="effort-head">
        <span>Effort</span> {LEVELS[shown].label}
      </div>
      <div
        ref={track}
        className="effort-track"
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown}
        aria-valuetext={LEVELS[shown].label}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setShown(Math.min(last, Math.max(0, stopAt(e))));
        }}
        onPointerMove={(e) => e.buttons && setShown(Math.min(last, Math.max(0, stopAt(e))))}
        onPointerUp={(e) => pick(stopAt(e))}
      >
        {LEVELS.map((l, i) => (
          <span key={l.value} className={cx("effort-tick", i <= shown && "hidden")} style={{ left: at(i, last) }} />
        ))}
        {/* Colour fills the track up to the thumb: a sliver at Instant, all of it at the top stop. */}
        <span className="effort-fill" style={{ width: `calc(${at(shown, last)} + ${PAD}px)` }} />
        <span className="effort-thumb" style={{ left: `calc(${at(shown, last)} + 8px)` }} />
      </div>
    </div>
  );
}
