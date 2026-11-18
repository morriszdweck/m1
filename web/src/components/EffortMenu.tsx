// Reasoning effort, at the right of the message box. The button names the level;
// clicking it opens a small slider to pick Instant (no thinking), Medium or High.

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api } from "../api";
import { errorToast, useStore } from "../store";
import type { ReasoningEffort } from "../types";
import { cx } from "../util";
import { Menu } from "./ui";

/** Space at each end of the track, so the thumb sits inside it at Low and High. */
const PAD = 20;
const at = (i: number, last: number) => `calc(${PAD}px + (100% - ${2 * PAD}px) * ${i / last})`;

const LEVELS: { value: ReasoningEffort; label: string }[] = [
  { value: "instant", label: "Instant" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function EffortMenu() {
  const saved = useStore((s) => s.settings?.reasoningEffort) ?? "medium";
  const index = Math.max(0, LEVELS.findIndex((l) => l.value === saved));

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
      items={() => <EffortSlider index={index} />}
    />
  );
}

function EffortSlider({ index }: { index: number }) {
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
        {/* Colour fills the track up to the thumb: a sliver at Instant, half at Medium, all of it at High. */}
        <span className="effort-fill" style={{ width: `calc(${at(shown, last)} + ${PAD}px)` }} />
        <span className="effort-thumb" style={{ left: `calc(${at(shown, last)} + 8px)` }} />
      </div>
    </div>
  );
}
