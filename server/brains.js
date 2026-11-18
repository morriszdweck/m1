// The two brains M1 ships, and which one this computer gets.
//
// A computer with 16 GB of memory or more gets SenseNova Loop 9B, when it can run it on a
// graphics chip (an Apple silicon Mac, or Linux with a Vulkan driver). Everything else keeps
// Spark X2.6 4B. M1_BRAIN=spark or M1_BRAIN=loop picks one by hand.
//
// They think in different ways, so the effort slider means different things:
//   Spark:  Instant (no thinking) · Medium (its own "low" thinking) · High (its "high" thinking)
//   Loop:   Instant (2 loops, as trained, no thinking) · Low (1 loop) · Medium (2 loops) ·
//           High (3 loops) · Max (4 loops)
// Loop's middle 24 layers run that many times per token. More loops = more computation per
// word, so it's slower. The engine M1 ships for Loop sets the count when the model loads.

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
    instant: { think: false, loops: 2 },
    low: { think: true, loops: 1 },
    medium: { think: true, loops: 2 },
    high: { think: true, loops: 3 },
    max: { think: true, loops: 4 },
  },
};
/** Loop as it was trained. Used when no effort applies (a model from Hugging Face never loops). */
export const TRAINED_LOOPS = 2;
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

/** {think, sparkEffort?, loops?} for a stop on the slider. */
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
