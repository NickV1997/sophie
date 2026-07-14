export type ModelTier = "9b" | "14b" | "35b" | "70b" | "100b+" | "unknown";
export interface ModelRuntimeProfile {
  tier: ModelTier;
  maxRounds: number;
  maxNudges: number;
  parallelTools: boolean;
  deterministicBias: "high" | "medium" | "normal";
  /** Verbatim/compacted transcript budget. The system prompt and current turn
   * sit outside this budget. Keeping it modest matters more than raw n_ctx. */
  recommendedHistoryTokens: number;
  /** Preferred total prompt size. All tiers stay below the hard 28k working
   * ceiling; smaller local models get a much leaner decision surface. */
  recommendedPromptTokens: number;
}
export function modelParameterBillions(id: string): number | null {
  const matches = [...id.matchAll(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*[bB](?:[^a-z]|$)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  return matches.length ? Math.max(...matches) : null;
}
export function modelRuntimeProfile(id: string): ModelRuntimeProfile {
  const b = modelParameterBillions(id);
  if (b != null && b <= 10) return { tier: "9b", maxRounds: 40, maxNudges: 3, parallelTools: false, deterministicBias: "high", recommendedHistoryTokens: 6_000, recommendedPromptTokens: 12_000 };
  if (b != null && b <= 20) return { tier: "14b", maxRounds: 60, maxNudges: 4, parallelTools: false, deterministicBias: "high", recommendedHistoryTokens: 8_000, recommendedPromptTokens: 14_000 };
  if (b != null && b <= 50) return { tier: "35b", maxRounds: 80, maxNudges: 5, parallelTools: true, deterministicBias: "medium", recommendedHistoryTokens: 10_000, recommendedPromptTokens: 18_000 };
  if (b != null && b < 100) return { tier: "70b", maxRounds: 100, maxNudges: 6, parallelTools: true, deterministicBias: "normal", recommendedHistoryTokens: 14_000, recommendedPromptTokens: 22_000 };
  if (b != null) return { tier: "100b+", maxRounds: 120, maxNudges: 8, parallelTools: true, deterministicBias: "normal", recommendedHistoryTokens: 16_000, recommendedPromptTokens: 26_000 };
  return { tier: "unknown", maxRounds: 80, maxNudges: 5, parallelTools: true, deterministicBias: "medium", recommendedHistoryTokens: 10_000, recommendedPromptTokens: 18_000 };
}
