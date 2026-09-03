import { describe, it, expect, vi } from "vitest";
import { splitAgentsByRouting, buildInvokeNativeAgentHandler } from "../../packages/kernel/src/native-agent-executor/registry.js";
import { createNativeAgentUsageCollector } from "../../packages/kernel/src/native-agent-executor/usage-collector.js";
import { NativeAgentExecutorError } from "../../packages/kernel/src/native-agent-executor/openrouter-executor.js";
import type { AgentDefinition } from "../../packages/kernel/src/agents.js";
import type { NativeAgentExecutor } from "../../packages/kernel/src/native-agent-executor/types.js";

describe("splitAgentsByRouting", () => {
  it("puts agents with no routing field into sdkAgents, unchanged", () => {
    const agents: Record<string, AgentDefinition> = {
      builder: { description: "d", prompt: "p", model: "opus" },
    };
    const { sdkAgents, toolAgents } = splitAgentsByRouting(agents);
    expect(sdkAgents.builder).toEqual({ description: "d", prompt: "p", model: "opus" });
    expect(toolAgents).toEqual({});
  });

  it("puts inherit/anthropic routing into sdkAgents (Task path unchanged)", () => {
    const agents: Record<string, AgentDefinition> = {
      a: { description: "d", prompt: "p", routing: { provider: "inherit", accountId: null, model: null, effort: null } },
      b: { description: "d", prompt: "p", model: "sonnet", routing: { provider: "anthropic", accountId: null, model: "claude-opus-5", effort: null } },
    };
    const { sdkAgents, toolAgents } = splitAgentsByRouting(agents);
    expect(Object.keys(sdkAgents).sort()).toEqual(["a", "b"]);
    expect(toolAgents).toEqual({});
    // routing field itself must not leak into what's handed to the SDK
    expect((sdkAgents.a as { routing?: unknown }).routing).toBeUndefined();
    expect((sdkAgents.b as { routing?: unknown }).routing).toBeUndefined();
  });

  it("openrouter-routed agents are OMITTED from sdkAgents and present in toolAgents", () => {
    const agents: Record<string, AgentDefinition> = {
      researcher: {
        description: "researches things",
        prompt: "You research.",
        maxTurns: 15,
        routing: { provider: "openrouter", accountId: "owner_openrouter", model: "anthropic/claude-3.5-sonnet", effort: "high" },
      },
    };
    const { sdkAgents, toolAgents } = splitAgentsByRouting(agents);
    expect(sdkAgents.researcher).toBeUndefined();
    expect(Object.keys(sdkAgents)).toEqual([]);
    expect(toolAgents.researcher).toEqual({
      description: "researches things",
      prompt: "You research.",
      model: "anthropic/claude-3.5-sonnet",
      accountId: "owner_openrouter",
      maxTurns: 15,
    });
  });

  it("handles a mixed roster: some Task, some tool-routed", () => {
    const agents: Record<string, AgentDefinition> = {
      builder: { description: "d", prompt: "p", model: "opus" },
      researcher: {
        description: "d",
        prompt: "p",
        routing: { provider: "openrouter", accountId: "owner_openrouter", model: "m/x", effort: null },
      },
      healer: { description: "d", prompt: "p", model: "sonnet" },
    };
    const { sdkAgents, toolAgents } = splitAgentsByRouting(agents);
    expect(Object.keys(sdkAgents).sort()).toEqual(["builder", "healer"]);
    expect(Object.keys(toolAgents)).toEqual(["researcher"]);
  });
});

describe("buildInvokeNativeAgentHandler", () => {
  const toolAgents = {
    researcher: {
      description: "researches",
      prompt: "You are a researcher.",
      model: "anthropic/claude-3.5-sonnet",
      accountId: "owner_openrouter",
    },
  };

  function makeStubExecutor(impl: NativeAgentExecutor["execute"]): NativeAgentExecutor {
    return { execute: impl };
  }

  it("only accepts configured tool-agent names -- an unconfigured name is rejected without calling the executor", async () => {
    const execute = vi.fn();
    const handler = buildInvokeNativeAgentHandler({
      toolAgents,
      credentials: { owner_openrouter: { apiKey: "sk-or-test" } },
      usageCollector: createNativeAgentUsageCollector(),
      signal: new AbortController().signal,
      executor: makeStubExecutor(execute),
    });

    const result = await handler({ agentName: "not-a-real-agent", input: "hi" });
    expect(result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when no credential is resolved for the agent's account, without calling the executor", async () => {
    const execute = vi.fn();
    const handler = buildInvokeNativeAgentHandler({
      toolAgents,
      credentials: {}, // nothing resolved
      usageCollector: createNativeAgentUsageCollector(),
      signal: new AbortController().signal,
      executor: makeStubExecutor(execute),
    });

    const result = await handler({ agentName: "researcher", input: "hi" });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).not.toContain("sk-or"); // no key material in the message
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes a successful executor result and records usage", async () => {
    const collector = createNativeAgentUsageCollector();
    const handler = buildInvokeNativeAgentHandler({
      toolAgents,
      credentials: { owner_openrouter: { apiKey: "sk-or-test" } },
      usageCollector: collector,
      signal: new AbortController().signal,
      executor: makeStubExecutor(async () => ({
        text: "the answer is 42",
        usage: {
          model: "anthropic/claude-3.5-sonnet",
          provider: "openrouter",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0,
        },
      })),
    });

    const result = await handler({ agentName: "researcher", input: "what is 6*7?" });
    expect(result).toEqual({ content: [{ type: "text", text: "the answer is 42" }] });
    expect(collector.snapshot()).toHaveLength(1);
    expect(collector.snapshot()[0]).toMatchObject({ provider: "openrouter", inputTokens: 10, outputTokens: 5 });
  });

  it("returns a generic tool error and never leaks the raw provider error", async () => {
    const handler = buildInvokeNativeAgentHandler({
      toolAgents,
      credentials: { owner_openrouter: { apiKey: "sk-or-SECRET-VALUE" } },
      usageCollector: createNativeAgentUsageCollector(),
      signal: new AbortController().signal,
      executor: makeStubExecutor(async () => {
        throw new NativeAgentExecutorError(
          "provider_error",
          new Error("OpenRouter request failed with status 401: Authorization header sk-or-SECRET-VALUE invalid, upstream host internal-billing.openrouter.internal"),
        );
      }),
    });

    const result = await handler({ agentName: "researcher", input: "hi" });
    expect(result).toMatchObject({ isError: true });
    const text = result.content[0].text;
    expect(text).not.toContain("sk-or-SECRET-VALUE");
    expect(text).not.toContain("openrouter.internal");
    expect(text).not.toContain("401");
  });

  it("maps timeout and cancelled kinds to distinct, still-generic messages", async () => {
    const collector = createNativeAgentUsageCollector();
    const timeoutHandler = buildInvokeNativeAgentHandler({
      toolAgents,
      credentials: { owner_openrouter: { apiKey: "sk-or-test" } },
      usageCollector: collector,
      signal: new AbortController().signal,
      executor: makeStubExecutor(async () => {
        throw new NativeAgentExecutorError("timeout");
      }),
    });
    const cancelledHandler = buildInvokeNativeAgentHandler({
      toolAgents,
      credentials: { owner_openrouter: { apiKey: "sk-or-test" } },
      usageCollector: collector,
      signal: new AbortController().signal,
      executor: makeStubExecutor(async () => {
        throw new NativeAgentExecutorError("cancelled");
      }),
    });

    const timeoutResult = await timeoutHandler({ agentName: "researcher", input: "hi" });
    const cancelledResult = await cancelledHandler({ agentName: "researcher", input: "hi" });
    expect(timeoutResult.content[0].text).toMatch(/time/i);
    expect(cancelledResult.content[0].text).toMatch(/cancel/i);
    expect(timeoutResult.content[0].text).not.toBe(cancelledResult.content[0].text);
  });
});
