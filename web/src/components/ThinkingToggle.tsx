// Thinking, at the right of the message box. On, Bonsai reasons before it
// answers; off, it answers straight away.

import { useState } from "react";
import { Lightbulb } from "lucide-react";
import { api } from "../api";
import { errorToast, useStore } from "../store";
import { cx } from "../util";

export function ThinkingToggle() {
  const saved = useStore((s) => s.settings?.thinking) ?? true;
  const [shown, setShown] = useState<boolean | null>(null);
  const on = shown ?? saved;

  function flip() {
    const next = !on;
    setShown(next);
    api("PATCH", "/api/settings", { thinking: next })
      .catch(errorToast)
      .finally(() => setShown(null));
  }

  return (
    <button
      className={cx("mode-btn", "think-btn", on && "on")}
      onClick={flip}
      role="switch"
      aria-checked={on}
      aria-label="Thinking"
      title={on ? "Thinking is on: it reasons before it answers" : "Thinking is off: it answers straight away"}
    >
      <Lightbulb size={14} />
      <span>Thinking</span>
    </button>
  );
}
