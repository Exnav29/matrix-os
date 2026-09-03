import { describe, it, expect } from "vitest";
import { createNativeAgentUsageCollector, foldNativeAgentUsage } from "../../packages/kernel/src/native-agent-executor/usage-collector.js";
import type { KernelModelUsage } from "../../packages/kernel/src/kernel.js";

function usage(overrides: Partial<KernelModelUsage> = {}): KernelModelUsage {
  return {
    model: "m",
    provider: "openrouter",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe("createNativeAgentUsageCollector", () => {
  it("records multiple entries in one collector", () => {
    const collector = createNativeAgentUsageCollector();
    collector.record(usage({ model: "a" }));
    collector.record(usage({ model: "b" }));
    collector.record(usage({ model: "c" }));
    expect(collector.snapshot().map((e) => e.model)).toEqual(["a", "b", "c"]);
  });

  it("supports concurrent (interleaved-async) record calls without dropping entries", async () => {
    const collector = createNativeAgentUsageCollector();
    const delays = [30, 5, 20, 10, 25, 1, 15];
    await Promise.all(delays.map((ms, i) => new Promise<void>((resolve) => {
      setTimeout(() => {
        collector.record(usage({ model: `agent-${i}` }));
        resolve();
      }, ms);
    })));
    expect(collector.snapshot()).toHaveLength(delays.length);
    expect(new Set(collector.snapshot().map((e) => e.model)).size).toBe(delays.length);
  });

  it("two independently-created collectors never share state (isolation between kernel runs)", () => {
    const runA = createNativeAgentUsageCollector();
    const runB = createNativeAgentUsageCollector();
    runA.record(usage({ model: "from-run-a" }));
    expect(runB.snapshot()).toHaveLength(0);
    expect(runA.snapshot()).toHaveLength(1);
  });

  it("snapshot() returns a defensive copy -- mutating it cannot corrupt collector state", () => {
    const collector = createNativeAgentUsageCollector();
    collector.record(usage());
    const snap = collector.snapshot();
    snap.push(usage({ model: "injected" }));
    expect(collector.snapshot()).toHaveLength(1);
  });
});

describe("foldNativeAgentUsage", () => {
  it("returns the base result untouched when there is no native-agent usage", () => {
    const base = { cost: 1, tokensIn: 100, tokensOut: 50, model: "claude-opus-5", modelUsage: [usage({ model: "claude-opus-5", costUsd: 1 })] };
    expect(foldNativeAgentUsage(base, [])).toBe(base);
  });

  it("additively merges SDK usage with native-agent usage into one modelUsage array", () => {
    const sdkUsage = usage({ model: "claude-opus-5", provider: "anthropic", inputTokens: 100, outputTokens: 50, costUsd: 1 });
    const base = { cost: 1, tokensIn: 100, tokensOut: 50, model: "claude-opus-5", provider: "anthropic", modelUsage: [sdkUsage] };
    const nativeUsage = usage({ model: "anthropic/claude-3.5-sonnet", provider: "openrouter", inputTokens: 20, outputTokens: 10, costUsd: 0.05 });

    const merged = foldNativeAgentUsage(base, [nativeUsage]);

    expect(merged.cost).toBeCloseTo(1.05, 10);
    expect(merged.tokensIn).toBe(120);
    expect(merged.tokensOut).toBe(60);
    expect(merged.modelUsage).toHaveLength(2);
    expect(merged.modelUsage).toContainEqual(sdkUsage);
    expect(merged.modelUsage).toContainEqual(nativeUsage);
    // primary model/provider (whatever the SDK itself reported) is preserved
    expect(merged.model).toBe("claude-opus-5");
    expect(merged.provider).toBe("anthropic");
  });

  it("merges multiple native-agent usage entries from one run", () => {
    const base = { cost: 0, tokensIn: 0, tokensOut: 0, modelUsage: [] as KernelModelUsage[] };
    const merged = foldNativeAgentUsage(base, [
      usage({ model: "m1", inputTokens: 5, outputTokens: 2, costUsd: 0.01 }),
      usage({ model: "m2", inputTokens: 7, outputTokens: 3, costUsd: 0.02 }),
    ]);
    expect(merged.tokensIn).toBe(12);
    expect(merged.tokensOut).toBe(5);
    expect(merged.cost).toBeCloseTo(0.03, 10);
    expect(merged.modelUsage).toHaveLength(2);
  });

  it("works when the base result has no prior modelUsage at all (pure OpenRouter run)", () => {
    const base = { cost: 0, tokensIn: 0, tokensOut: 0 };
    const merged = foldNativeAgentUsage(base, [usage({ model: "m", inputTokens: 4, outputTokens: 2, costUsd: 0.01 })]);
    expect(merged.modelUsage).toHaveLength(1);
    expect(merged.tokensIn).toBe(4);
  });
});
