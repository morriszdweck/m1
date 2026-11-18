// The two brains M1 ships, and which one this computer gets.
//
// A computer with 16 GB of memory or more gets SenseNova Loop 9B, when it can run it on a
// graphics chip (an Apple silicon Mac, or Linux with a Vulkan driver). Everything else keeps
// Spark X2.6 4B. M1_BRAIN=spark or M1_BRAIN=loop picks one by hand.
//
// They think in different ways, so the effort slider means different things:
//   Spark:  Instant (no thinking) · Medium (its own "low" thinking) · High (its "high" thinking)
//   Loop:   Instant (no thinking) · Low · Medium · High · Max (thinking, told how hard to think)
// Loop's template only turns thinking on or off, so the system prompt says how much to think
// at each stop, and a cap on thinking tokens catches a stop that thinks far past it (the
// engine then closes the thinking and Loop answers from what it has).
// Loop always runs its middle layers twice, as released: SenseNova's model card says the
// checkpoint's loop count is part of how it must be run. Its 3- and 4-loop gains come from
// models trained that way, which aren't released.

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
    detail: "SenseNova Loop 9B. Runs its middle layers twice for more depth, thinks as hard as you ask, writes and takes actions.",
    repo: "sensenova/SenseNova-Loop-9B-GGUF",
    prefix: "SenseNova-Loop-9B-",
    quants: [
      { id: "Q4_K_M", label: "Balanced", bytes: 5.82e9, note: "Recommended" },
      { id: "Q8_0", label: "Best", bytes: 9.8e9, note: "Near full quality", minGB: 24 },
    ],
    efforts: ["instant", "low", "medium", "high", "max"],
    /** Loop writes Qwen's <tool_call><function=name><parameter=k>v</parameter></function></tool_call>. */
    calls: "qwen",
    engine: "loop",
  },
};

/** What each stop on the slider does for each brain. */
const EFFORTS = {
  spark: {
    instant: { think: false },
    medium: { think: true, sparkEffort: "low" },
    high: { think: true, sparkEffort: "high" },
  },
  loop: {
    instant: { think: false },
    low: { think: true, hint: "Effort: low. Think briefly, a few short lines at most, then answer.", thinkCap: 1024 },
    medium: { think: true, thinkCap: 6144 },
    high: { think: true, hint: "Effort: high. Think the problem through carefully and check your work before you answer.", thinkCap: 12288 },
    max: {
      think: true,
      hint: "Effort: max. Take all the time you need: work through the problem step by step, weigh other approaches, and double-check your answer.",
    },
  },
};
export const ALL_EFFORTS = ["instant", "low", "medium", "high", "max"];

/** How much the brain may write per step at each effort, thinking included. */
export const STEP_TOKENS = { instant: 2048, low: 8192, medium: 8192, high: 16384, max: 24576 };

/** A saved stop this brain doesn't have moves to the nearest one it does (Spark has no Low or Max). */
export function effortLevel(brain, saved) {
  const levels = BRAINS[brain]?.efforts ?? BRAINS.spark.efforts;
  if (levels.includes(saved)) return saved;
  if (saved === "low") return levels.includes("medium") ? "medium" : levels[0];
  if (saved === "max") return levels[levels.length - 1];
  return levels.includes("medium") ? "medium" : levels[0];
}

/** {think, sparkEffort?, hint?, thinkCap?} for a stop on the slider. */
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
