import type { CaseRecord } from "./report.ts";

export interface Rollup {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
}

export interface BenchSummary extends Rollup {
  model: string;
  baseUrl: string;
  generatedAt: string;
  byCategory: Record<string, Rollup>;
  byComplexity: Record<string, Rollup>;
}

function rollup(records: CaseRecord[]): Rollup {
  const passed = records.filter((r) => r.ok).length;
  const total = records.length;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total ? +(passed / total).toFixed(3) : 0,
  };
}

function grouped(records: CaseRecord[], key: "category" | "complexity"): Record<string, Rollup> {
  const groups = new Map<string, CaseRecord[]>();
  for (const record of records) {
    const value = record[key];
    groups.set(value, [...(groups.get(value) ?? []), record]);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => [name, rollup(rows)]));
}

export function buildBenchSummary(records: CaseRecord[], meta: { model: string; baseUrl: string; generatedAt?: string }): BenchSummary {
  return {
    model: meta.model,
    baseUrl: meta.baseUrl,
    ...rollup(records),
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    byCategory: grouped(records, "category"),
    byComplexity: grouped(records, "complexity"),
  };
}

