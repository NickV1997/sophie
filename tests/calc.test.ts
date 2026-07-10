import { describe, expect, test } from "bun:test";
import { calc, calculate } from "../src/tools/calc.ts";

describe("calculate", () => {
  test("basic arithmetic and precedence", () => {
    expect(calculate("1 + 2 * 3")).toBe(7);
    expect(calculate("(1 + 2) * 3")).toBe(9);
    expect(calculate("10 - 4 - 3")).toBe(3); // left-associative
    expect(calculate("20 / 4 / 5")).toBe(1);
    expect(calculate("17 % 5")).toBe(2);
  });

  test("power is right-associative and binds tighter than unary", () => {
    expect(calculate("2 ^ 3 ^ 2")).toBe(512); // 2^(3^2)
    expect(calculate("2 ** 10")).toBe(1024);
    expect(calculate("-2 ^ 2")).toBe(-4); // -(2^2)
    expect(calculate("sqrt(2)^2")).toBeCloseTo(2, 10);
  });

  test("unary minus and grouping", () => {
    expect(calculate("-5 + 3")).toBe(-2);
    expect(calculate("-(3 + 4)")).toBe(-7);
    expect(calculate("--5")).toBe(5);
  });

  test("float noise is cleaned by the tool formatter", async () => {
    // raw evaluation still carries binary noise
    expect(calculate("0.1 + 0.2")).toBeCloseTo(0.3, 10);
    // but the tool output formats it cleanly
    const r = await calc.execute({ expression: "0.1 + 0.2" }, { cwd: "." });
    expect(r.content).toContain("= 0.3");
    expect(r.isError).toBeFalsy();
  });

  test("constants and functions", () => {
    expect(calculate("pi")).toBeCloseTo(Math.PI, 12);
    expect(calculate("tau")).toBeCloseTo(2 * Math.PI, 12);
    expect(calculate("sqrt(144)")).toBe(12);
    expect(calculate("max(3, 7, 2)")).toBe(7);
    expect(calculate("min(3, 7, 2)")).toBe(2);
    expect(calculate("fact(5)")).toBe(120);
    expect(calculate("gcd(24, 36)")).toBe(12);
    expect(calculate("hypot(3, 4)")).toBe(5);
    expect(calculate("round(2.5)")).toBe(3);
  });

  test("percentages expressed as decimals", () => {
    expect(calculate("0.15 * 200")).toBe(30);
    expect(calculate("349 * 1.0825")).toBeCloseTo(377.7925, 6);
  });

  test("digit separators", () => {
    expect(calculate("1_000_000 + 1")).toBe(1_000_001);
    expect(calculate("1000000 / 1000")).toBe(1000);
  });

  test("scientific notation", () => {
    expect(calculate("1e3")).toBe(1000);
    expect(calculate("1.5e-2")).toBe(0.015);
  });

  test("rejects invalid input rather than executing code", () => {
    expect(() => calculate("")).toThrow();
    expect(() => calculate("2 +")).toThrow();
    expect(() => calculate("(1 + 2")).toThrow();
    expect(() => calculate("1 2 3")).toThrow();
    expect(() => calculate("process.exit(1)")).toThrow();
    expect(() => calculate("foo(2)")).toThrow();
    expect(() => calculate("1; rm -rf /")).toThrow();
  });

  test("execute returns a clean error result, never throws", async () => {
    const bad = await calc.execute({ expression: "1 +" }, { cwd: "." });
    expect(bad.isError).toBe(true);
    const empty = await calc.execute({ expression: "  " }, { cwd: "." });
    expect(empty.isError).toBe(true);
  });
});
