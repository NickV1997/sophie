export type ModelTier = "9b" | "14b" | "35b" | "70b" | "100b+" | "unknown";
export interface ModelRuntimeProfile { tier: ModelTier; maxRounds: number; maxNudges: number; parallelTools: boolean; deterministicBias: "high" | "medium" | "normal"; recommendedHistoryTokens: number; }
export function modelParameterBillions(id: string): number | null {
  const matches = [...id.matchAll(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*[bB](?:[^a-z]|$)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  return matches.length ? Math.max(...matches) : null;
}
export function modelRuntimeProfile(id: string): ModelRuntimeProfile {
  const b = modelParameterBillions(id);
  if (b != null && b <= 10) return { tier: "9b", maxRounds: 70, maxNudges: 4, parallelTools: false, deterministicBias: "high", recommendedHistoryTokens: 12_000 };
  if (b != null && b <= 20) return { tier: "14b", maxRounds: 100, maxNudges: 6, parallelTools: false, deterministicBias: "high", recommendedHistoryTokens: 18_000 };
  if (b != null && b <= 50) return { tier: "35b", maxRounds: 140, maxNudges: 8, parallelTools: true, deterministicBias: "medium", recommendedHistoryTokens: 24_000 };
  if (b != null && b < 100) return { tier: "70b", maxRounds: 180, maxNudges: 10, parallelTools: true, deterministicBias: "normal", recommendedHistoryTokens: 32_000 };
  if (b != null) return { tier: "100b+", maxRounds: 200, maxNudges: 12, parallelTools: true, deterministicBias: "normal", recommendedHistoryTokens: 40_000 };
  return { tier: "unknown", maxRounds: 140, maxNudges: 8, parallelTools: true, deterministicBias: "medium", recommendedHistoryTokens: 24_000 };
}
