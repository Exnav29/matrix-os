import type { KernelModelUsage } from "../kernel.js";

/**
 * Accumulates usage/cost entries for OpenRouter-routed native-agent tool
 * calls made during ONE spawnKernel() invocation, so they can be folded into
 * KernelResult.modelUsage alongside whatever the SDK itself reports.
 *
 * Spike-confirmed design (MAT #1534 usage spike): a plain closure over a
 * local array, instantiated fresh per spawnKernel() call and threaded down
 * as an explicit parameter -- never attached to the object handed to the
 * SDK's query() options, never a module-level singleton, never globalThis.
 * record() is one synchronous Array.push per call, which is safe under
 * Node's single-threaded event loop even when multiple invoke_native_agent
 * tool calls are in flight concurrently -- there is no read-modify-write
 * window a competing call can interleave into.
 */
export interface NativeAgentUsageCollector {
  record(entry: KernelModelUsage): void;
  snapshot(): KernelModelUsage[];
}

export function createNativeAgentUsageCollector(): NativeAgentUsageCollector {
  const entries: KernelModelUsage[] = [];
  return {
    record(entry) {
      entries.push(entry);
    },
    snapshot() {
      // Defensive copy: callers must not be able to mutate collector-internal
      // state by mutating a previously returned snapshot.
      return [...entries];
    },
  };
}

/**
 * Additively merges native-agent-executor usage into a KernelResult-shaped
 * base (as produced by kernel.ts's normalizeSdkResult). Pure function, no
 * I/O -- kept separate from kernel.ts so it is directly unit-testable.
 */
export function foldNativeAgentUsage<T extends {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  provider?: string;
  modelUsage?: KernelModelUsage[];
}>(base: T, nativeAgentUsage: KernelModelUsage[]): T {
  if (nativeAgentUsage.length === 0) return base;

  const addedCost = nativeAgentUsage.reduce((total, usage) => total + usage.costUsd, 0);
  const addedTokensIn = nativeAgentUsage.reduce(
    (total, usage) => total + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    0,
  );
  const addedTokensOut = nativeAgentUsage.reduce((total, usage) => total + usage.outputTokens, 0);
  const mergedModelUsage = [...(base.modelUsage ?? []), ...nativeAgentUsage];

  return {
    ...base,
    cost: Number((base.cost + addedCost).toFixed(12)),
    tokensIn: base.tokensIn + addedTokensIn,
    tokensOut: base.tokensOut + addedTokensOut,
    // Preserve whichever primary model/provider the SDK itself reported;
    // native-agent usage is additional spend, not a change of the turn's
    // primary model.
    modelUsage: mergedModelUsage,
  };
}
