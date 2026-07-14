import { describe, expect, test } from "bun:test";
import { modelParameterBillions, modelRuntimeProfile } from "../src/llm/model-profile.ts";
describe("local model runtime profiles", () => {
  test("detects common parameter tiers from model ids", () => { expect(modelParameterBillions("Qwen3-9B-Q4.gguf")).toBe(9); expect(modelRuntimeProfile("Qwen3-14B").tier).toBe("14b"); expect(modelRuntimeProfile("Qwen3-35B-A3B").tier).toBe("35b"); expect(modelRuntimeProfile("Llama-70B").tier).toBe("70b"); expect(modelRuntimeProfile("Model-122B").tier).toBe("100b+"); });
  test("uses stricter execution for small models", () => { const small = modelRuntimeProfile("model-9B"), large = modelRuntimeProfile("model-70B"); expect(small.parallelTools).toBe(false); expect(small.maxRounds).toBeLessThan(large.maxRounds); expect(small.deterministicBias).toBe("high"); expect(small.recommendedPromptTokens).toBeLessThan(large.recommendedPromptTokens); });
  test("keeps every 9B-122B prompt target below the local-model quality ceiling", () => {
    for (const id of ["model-9B", "model-14B", "model-35B", "model-70B", "model-122B"]) {
      expect(modelRuntimeProfile(id).recommendedPromptTokens).toBeLessThan(28_000);
    }
  });
});
