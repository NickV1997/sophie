import { describe, expect, test } from "bun:test";
import { getSecret, setSecret } from "../src/system/secrets.ts";

describe("secret storage", () => {
  test("environment remains the portable override", () => {
    process.env.TAVILY_API_KEY = "test-secret";
    expect(getSecret("TAVILY_API_KEY")).toBe("test-secret");
    delete process.env.TAVILY_API_KEY;
  });
  test("unsupported keys cannot be written to Keychain", () => {
    expect(setSecret("NOT_A_SOPHIE_SECRET", "x")).toBe(false);
  });
});
