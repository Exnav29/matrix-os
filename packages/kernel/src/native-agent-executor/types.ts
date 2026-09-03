import type { KernelModelUsage } from "../kernel.js";

/** Pre-resolved, in-memory-only credential for one provider account. Never
 * persisted by the kernel package, never logged, never returned to the model. */
export interface NativeAgentCredential {
  apiKey: string;
  baseUrl?: string;
}

export interface NativeAgentExecutionInput {
  agentName: string;
  systemPrompt: string;
  userInput: string;
  model: string;
  maxOutputTokens?: number;
}

export interface NativeAgentExecutionResult {
  text: string;
  usage: KernelModelUsage;
}

export interface NativeAgentExecutor {
  execute(
    input: NativeAgentExecutionInput,
    credential: NativeAgentCredential,
    signal: AbortSignal,
  ): Promise<NativeAgentExecutionResult>;
}
