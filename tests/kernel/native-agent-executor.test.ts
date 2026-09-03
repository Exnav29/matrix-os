import { describe, it, expect } from "vitest";
import { createOpenRouterExecutor, NativeAgentExecutorError } from "../../packages/kernel/src/native-agent-executor/openrouter-executor.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("createOpenRouterExecutor", () => {
  it("sends system+user messages and normalizes a successful response", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const executor = createOpenRouterExecutor({
      fetcher: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return jsonResponse({
          model: "anthropic/claude-3.5-sonnet",
          choices: [{ message: { content: "42" } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }) as never;
      },
    });

    const result = await executor.execute(
      { agentName: "researcher", systemPrompt: "You are a researcher.", userInput: "6*7?", model: "anthropic/claude-3.5-sonnet" },
      { apiKey: "sk-or-test" },
      new AbortController().signal,
    );

    expect(result.text).toBe("42");
    expect(result.usage).toEqual({
      model: "anthropic/claude-3.5-sonnet",
      provider: "openrouter",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    });

    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a researcher." },
      { role: "user", content: "6*7?" },
    ]);
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
  });

  it("does not fabricate a cost figure when the response provides none", async () => {
    const executor = createOpenRouterExecutor({
      fetcher: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) as never,
    });
    const result = await executor.execute(
      { agentName: "a", systemPrompt: "s", userInput: "u", model: "m/x" },
      { apiKey: "k" },
      new AbortController().signal,
    );
    expect(result.usage.costUsd).toBe(0);
  });

  it("wraps a non-ok HTTP response as provider_error, keeping details only in .cause", async () => {
    const executor = createOpenRouterExecutor({
      fetcher: async () => jsonResponse({ error: "invalid api key sk-or-REAL-SECRET" }, false, 401) as never,
    });

    await expect(
      executor.execute({ agentName: "a", systemPrompt: "s", userInput: "u", model: "m/x" }, { apiKey: "k" }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "provider_error" });

    try {
      await executor.execute({ agentName: "a", systemPrompt: "s", userInput: "u", model: "m/x" }, { apiKey: "k" }, new AbortController().signal);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NativeAgentExecutorError);
      const e = err as NativeAgentExecutorError;
      expect(e.message).toBe("provider_error"); // Error#message never carries the raw body
    }
  });

  it("throws invalid_response when the body has no usable text", async () => {
    const executor = createOpenRouterExecutor({
      fetcher: async () => jsonResponse({ choices: [] }) as never,
    });
    await expect(
      executor.execute({ agentName: "a", systemPrompt: "s", userInput: "u", model: "m/x" }, { apiKey: "k" }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("propagates parent cancellation as kind 'cancelled'", async () => {
    const controller = new AbortController();
    const executor = createOpenRouterExecutor({
      fetcher: (_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });

    const pending = executor.execute(
      { agentName: "a", systemPrompt: "s", userInput: "u", model: "m/x" },
      { apiKey: "k" },
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("fails immediately with kind 'cancelled' if the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalled = false;
    const executor = createOpenRouterExecutor({
      fetcher: async () => {
        fetchCalled = true;
        return jsonResponse({ choices: [{ message: { content: "x" } }] }) as never;
      },
    });

    await expect(
      executor.execute({ agentName: "a", systemPrompt: "s", userInput: "u", model: "m/x" }, { apiKey: "k" }, controller.signal),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetchCalled).toBe(false);
  });

  it("times out independently of the parent signal", async () => {
    const executor = createOpenRouterExecutor({
      timeoutMs: 10,
      fetcher: (_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });

    await expect(
      executor.execute(
        { agentName: "a", systemPrompt: "s", userInput: "u", model: "m/x" },
        { apiKey: "k" },
        new AbortController().signal, // parent never aborts
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
