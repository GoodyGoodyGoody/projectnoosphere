import { CANARIES, TRIAL_CANARIES } from "./canaries.ts";

// Pure selection keeps tests away from provider calls and environment loading.
export function selectSmoke(args: readonly string[]) {
  const trial = args.includes("--trial");
  return {
    trial,
    canaries: trial ? TRIAL_CANARIES : CANARIES,
    reviewerLabels: trial
      ? ["opus-medium", "gpt-6-sol"]
      : ["opus-medium", "opus-low", "gpt-6-sol", "gpt-5.4-mini"],
    repetitions: trial ? 3 : 1,
    pairs: trial
      ? [["opus-medium", "gpt-6-sol"]]
      : [["opus-medium", "gpt-6-sol"], ["opus-medium", "gpt-5.4-mini"], ["opus-low", "gpt-6-sol"]],
  };
}
