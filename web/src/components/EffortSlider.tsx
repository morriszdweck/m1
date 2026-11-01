// The reasoning effort slider in the message box's bottom row. K2 Horizon thinks
// briefly (Low), for a while (Medium) or as long as it needs (High) before it answers.

import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { api } from "../api";
import { errorToast, useStore } from "../store";
import type { ReasoningEffort } from "../types";

const LEVELS: { value: ReasoningEffort; label: string; detail: string }[] = [
  { value: "low", label: "Low", detail: "Thinks briefly. Fastest answers." },
  { value: "medium", label: "Medium", detail: "Thinks for a while. A good balance." },
  { value: "high", label: "High", detail: "Thinks as long as it needs. Best for hard problems." },
];

export function EffortSlider() {
  const saved = useStore((s) => s.settings?.reasoningEffort) ?? "high";
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const index = Math.max(0, LEVELS.findIndex((l) => l.value === value));
  const level = LEVELS[index];

  function pick(next: ReasoningEffort) {
    if (next === value) return;
    setValue(next);
    api("PATCH", "/api/settings", { reasoningEffort: next }).catch((e) => {
      setValue(saved);
      errorToast(e);
    });
  }

  return (
    <label className="effort" title={`Reasoning effort: ${level.label}. ${level.detail}`}>
      <Brain size={16} />
      <input
        type="range"
        min={0}
        max={LEVELS.length - 1}
        step={1}
        value={index}
        onChange={(e) => pick(LEVELS[Number(e.target.value)].value)}
        aria-label="Reasoning effort"
        aria-valuetext={level.label}
        style={{ "--fill": `${(index / (LEVELS.length - 1)) * 100}%` } as React.CSSProperties}
      />
      <span>{level.label}</span>
    </label>
  );
}
