// The two brains M1 ships, and which one this computer gets.
//
// A computer with 16 GB of memory or more gets SenseNova Loop 9B, when it can run it on a
// graphics chip (an Apple silicon Mac, or Linux with a Vulkan driver). Everything else keeps
// Spark X2.6 4B. M1_BRAIN=spark or M1_BRAIN=loop picks one by hand.
//
// They think in different ways, so the control beside the message box differs:
//   Spark:  a slider. Instant (no thinking) · Medium (its own "low" thinking) · High (its "high" thinking)
//   Loop:   a thinking toggle. Off is "instant", on is "medium". Both run the model as released,
//           its middle 24 layers twice per word (2 loops).

import os from "node:os";
import { IS_MAC } from "./core.js";
import { linuxGPU } from "./platform.js";

export const BRAINS = {
  spark: {
    id: "Spark-X2.6-4B",
    label: "Spark X2.6 4B",
    detail: "Spark X2.6 4B. Thinks as hard as you ask, writes and takes actions.",
    repo: "XHToken/Spark-X2.6-4B-GGUF",
    prefix: "Spark-X2.6-4B-",
    quants: [
      { id: "Q4_K_M", label: "Balanced", bytes: 3.54e9, note: "Recommended" },
      { id: "Q8_0", label: "Best", bytes: 4.38e9, note: "Near full quality" },
    ],
    efforts: ["instant", "medium", "high"],
    /** Spark writes <tool_call>name<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>. */
    calls: "spark",
    engine: "stock",
  },
  loop: {
    id: "SenseNova-Loop-9B",
    label: "SenseNova Loop 9B",
    detail: "SenseNova Loop 9B. Runs its middle layers again to think deeper, writes and takes actions.",
    repo: "sensenova/SenseNova-Loop-9B-GGUF",
    prefix: "SenseNova-Loop-9B-",
    quants: [
      { id: "Q4_K_M", label: "Balanced", bytes: 5.82e9, note: "Recommended" },
      { id: "Q8_0", label: "Best", bytes: 9.8e9, note: "Near full quality", minGB: 24 },
    ],
    efforts: ["instant", "medium"],
    /** Loop writes Qwen's <tool_call><function=name><parameter=k>v</parameter></function></tool_call>. */
    calls: "qwen",
    engine: "loop",
  },
};

/** What each stop does for each brain. */
const EFFORTS = {
  spark: {
    instant: { think: false },
    medium: { think: true, sparkEffort: "low" },
    high: { think: true, sparkEffort: "high" },
  },
  loop: {
    instant: { think: false },
    // Loop has one thinking mode, so a step gets as long as it needs to finish thinking.
    medium: { think: true, stepTokens: 24576 },
  },
};
export const ALL_EFFORTS = ["instant", "medium", "high"];

/** How much the brain may write per step at each effort, thinking included. */
export const STEP_TOKENS = { instant: 2048, medium: 8192, high: 16384 };

/** A saved stop this brain doesn't have moves to Medium (Loop has no High: it means thinking on). */
export function effortLevel(brain, saved) {
  const levels = BRAINS[brain]?.efforts ?? BRAINS.spark.efforts;
  if (levels.includes(saved)) return saved;
  return levels.includes("medium") ? "medium" : levels[0];
}

/** {think, sparkEffort?, stepTokens?} for a stop. */
export function effortPlan(brain, saved) {
  const table = EFFORTS[brain] ?? EFFORTS.spark;
  return table[effortLevel(brain, saved)];
}

/** The brain this computer should run. */
export const BRAIN = (() => {
  const wanted = process.env.M1_BRAIN;
  if (wanted === "spark" || wanted === "loop") return wanted;
  // A "16 GB" computer reports a little under 16 GiB once the system takes its share.
  if (os.totalmem() / 2 ** 30 < 15) return "spark";
  if (IS_MAC) return process.arch === "arm64" ? "loop" : "spark";
  return process.platform === "linux" && process.arch === "x64" && linuxGPU().vulkan ? "loop" : "spark";
})();

/** The sizes this computer is offered for a brain (Loop's Best needs more memory). */
export function quantsFor(brain) {
  const memory = os.totalmem() / 2 ** 30;
  return BRAINS[brain].quants.filter((q) => !q.minGB || memory >= q.minGB - 1);
}
