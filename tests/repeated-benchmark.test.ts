import { describe, expect, test } from "bun:test";
import { repeatedStats } from "../src/bench/repeat.ts";
describe("repeated benchmark statistics", () => { test("reports variance and worst run", () => { const s = repeatedStats([1, .98, .96], 0); expect(s.runs).toBe(3); expect(s.minPassRate).toBe(.96); expect(s.meanPassRate).toBeCloseTo(.98); expect(s.standardDeviation).toBeGreaterThan(0); }); });
