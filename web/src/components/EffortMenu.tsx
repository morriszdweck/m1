// The reasoning effort menu in the message box's bottom row. K2 Horizon thinks
// briefly (Low), for a while (Medium) or as long as it needs (High) before it answers.

import { Brain } from "lucide-react";
import { api } from "../api";
import { errorToast, useStore } from "../store";
import type { ReasoningEffort } from "../types";
import { cx } from "../util";
import { Menu } from "./ui";

const LEVELS: { value: ReasoningEffort; label: string; detail: string }[] = [
  { value: "low", label: "Low", detail: "Thinks briefly. Fastest answers." },
  { value: "medium", label: "Medium", detail: "Thinks for a while. A good balance." },
  { value: "high", label: "High", detail: "Thinks as long as it needs. Best for hard problems." },
];

export function EffortMenu() {
  const saved = useStore((s) => s.settings?.reasoningEffort) ?? "high";
  const level = LEVELS.find((l) => l.value === saved) ?? LEVELS[2];

  return (
    <Menu
      side="top"
      width={280}
      trigger={(open, toggle) => (
        <button className={cx("mode-btn", open && "active")} onClick={toggle} aria-label={`Reasoning effort: ${level.label}`} title="Reasoning effort">
          <Brain size={15} />
          <span>{level.label}</span>
        </button>
      )}
      items={LEVELS.map((l) => ({
        label: l.label,
        detail: l.detail,
        checked: l.value === level.value,
        onClick: () => api("PATCH", "/api/settings", { reasoningEffort: l.value }).catch(errorToast),
      }))}
    />
  );
}
