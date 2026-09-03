import type { KernelModelUsage } from "../kernel.js";
import type {
  NativeAgentCredential,
  NativeAgentExecutionInput,
  NativeAgentExecutionResult,
  NativeAgentExecutor,
} from "./types.js";

// Same OpenRouter/OpenAI-compatible chat-completions shape already used by
// the Perplexity-over-OpenRouter fallback in ../tools/web-search.ts.
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_PER_AGENT_TIMEOUT_MS = 60_000;

export type NativeAgentExecutorErrorKind =
  | "cancelled"
  | "timeout"
  | "network"
  | "provider_error"
  | "invalid_response";

/**
 * Thrown by the executor on any failure. `cause` may carry the real
 * upstream status/body/network error for server-side logging ONLY --
 * callers must never forward `.cause` (or `.message` built from it) into a
 * tool result, prompt, or client-facing surface. Only `kind` is safe to
 * expose, and even that only as a generic, pre-written sentence.
 */
export class NativeAgentExecutorError extends Error {
  constructor(readonly kind: NativeAgentExecutorErrorKind, cause?: unknown) {
    super(kind);
    this.name = "NativeAgentExecutorError";
    if (cause !== undefined) this.cause = cause;
  }
}

interface FetchLike {
  (url: string, init?: RequestInit): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface OpenRouterExecutorOptions {
  fetcher?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}

export function createOpenRouterExecutor(opts: OpenRouterExecutorOptions = {}): NativeAgentExecutor {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PER_AGENT_TIMEOUT_MS;

  return {
    async execute(
      input: NativeAgentExecutionInput,
      credential: NativeAgentCredential,
      parentSignal: AbortSignal,
    ): Promise<NativeAgentExecutionResult> {
      if (parentSignal.aborted) {
        throw new NativeAgentExecutorError("cancelled");
      }

      const baseUrl = (opts.baseUrl ?? credential.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/$/, "");
      const endpoint = `${baseUrl}/chat/completions`;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([parentSignal, timeoutSignal]);

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: input.model,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userInput },
            ],
            ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}),
          }),
          signal,
        } as RequestInit);
      } catch (err) {
        if (parentSignal.aborted) throw new NativeAgentExecutorError("cancelled", err);
        if (timeoutSignal.aborted) throw new NativeAgentExecutorError("timeout", err);
        throw new NativeAgentExecutorError("network", err);
      }

      if (!response.ok) {
        // Real status/body captured only in `cause`, for server-side logs.
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch (err) {
          console.warn("[native-agent-executor] failed to read OpenRouter error body:", err instanceof Error ? err.name : "UnknownError");
        }
        throw new NativeAgentExecutorError(
          "provider_error",
          new Error(`OpenRouter request failed with status ${response.status}: ${bodyText.slice(0, 500)}`),
        );
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (err) {
        throw new NativeAgentExecutorError("invalid_response", err);
      }

      return normalizeOpenRouterResponse(data, input.model);
    },
  };
}

function normalizeOpenRouterResponse(data: unknown, requestedModel: string): NativeAgentExecutionResult {
  const parsed = data as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = parsed.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new NativeAgentExecutorError("invalid_response");
  }

  const usage: KernelModelUsage = {
    model: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : requestedModel,
    provider: "openrouter",
    inputTokens: safeCount(parsed.usage?.prompt_tokens),
    outputTokens: safeCount(parsed.usage?.completion_tokens),
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    // OpenRouter's chat-completions response does not reliably carry a cost
    // figure across every upstream model/route, and Matrix does not yet
    // maintain a per-model OpenRouter price catalog to derive one from
    // token counts. Recording 0 (documented) rather than a fabricated
    // number -- do not "improve" this without a real price source.
    costUsd: 0,
  };

  return { text, usage };
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}
