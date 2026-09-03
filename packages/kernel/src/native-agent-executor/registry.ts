import type { AgentDefinition } from "../agents.js";
import { createOpenRouterExecutor, NativeAgentExecutorError } from "./openrouter-executor.js";
import type { NativeAgentUsageCollector } from "./usage-collector.js";
import type { NativeAgentCredential, NativeAgentExecutor } from "./types.js";

/** What actually gets handed to the Claude Agent SDK's `agents` option --
 * `routing` is a Matrix-only field the SDK type has never heard of. */
export type SdkAgentDefinition = Omit<AgentDefinition, "routing">;

export interface OpenRouterToolAgent {
  description: string;
  prompt: string;
  model: string;
  accountId: string;
  maxTurns?: number;
}

export interface SplitAgentsResult {
  sdkAgents: Record<string, SdkAgentDefinition>;
  toolAgents: Record<string, OpenRouterToolAgent>;
}

/**
 * Buckets a merged (core + custom) agent map into the SDK Task path vs. the
 * provider-neutral tool path, per MAT #1534. An agent with no `routing`, or
 * `routing.provider` "inherit"/"anthropic", is unchanged legacy behavior and
 * goes to `sdkAgents` verbatim (minus the `routing` field itself, which the
 * SDK does not know about). Only `routing.provider === "openrouter"` is
 * pulled out into `toolAgents` and thereby OMITTED from the SDK's `agents`
 * map -- it cannot be reached via Task, only via invoke_native_agent.
 */
export function splitAgentsByRouting(
  agents: Record<string, AgentDefinition>,
): SplitAgentsResult {
  const sdkAgents: Record<string, SdkAgentDefinition> = {};
  const toolAgents: Record<string, OpenRouterToolAgent> = {};

  for (const [name, agent] of Object.entries(agents)) {
    const { routing, ...sdkShape } = agent;
    if (routing?.provider === "openrouter" && routing.accountId && routing.model) {
      toolAgents[name] = {
        description: agent.description,
        prompt: agent.prompt,
        model: routing.model,
        accountId: routing.accountId,
        ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
      };
      continue;
    }
    sdkAgents[name] = sdkShape;
  }

  return { sdkAgents, toolAgents };
}

function nativeAgentFailureMessage(kind: string): string {
  switch (kind) {
    case "timeout":
      return "The agent's provider did not respond in time.";
    case "cancelled":
      return "The agent invocation was cancelled.";
    case "invalid_response":
      return "The agent's provider returned an unexpected response.";
    default:
      return "The agent's provider request failed.";
  }
}

export interface CreateNativeAgentToolServerOptions {
  toolAgents: Record<string, OpenRouterToolAgent>;
  /** accountId -> credential, pre-resolved and validated by the gateway
   * before spawnKernel(). Only accounts actually referenced by toolAgents
   * should appear here (see PHASE 1 "Credential handling"). */
  credentials: Record<string, NativeAgentCredential>;
  usageCollector: NativeAgentUsageCollector;
  signal: AbortSignal;
  /** Injectable for tests; defaults to the real OpenRouter HTTP executor. */
  executor?: NativeAgentExecutor;
}

export type InvokeNativeAgentResult =
  | { content: [{ type: "text"; text: string }] }
  | { isError: true; content: [{ type: "text"; text: string }] };

/**
 * The actual tool logic, extracted from the SDK's tool()/createSdkMcpServer()
 * wrapping so it is directly unit-testable without touching the SDK or its
 * MCP transport at all -- createNativeAgentToolServer below is a thin SDK
 * adapter around this.
 */
export function buildInvokeNativeAgentHandler(
  options: CreateNativeAgentToolServerOptions,
): (args: { agentName: string; input: string }) => Promise<InvokeNativeAgentResult> {
  const { toolAgents, credentials, usageCollector, signal, executor = createOpenRouterExecutor() } = options;

  return async ({ agentName, input }) => {
    const agent = toolAgents[agentName];
    // Defense in depth: the zod enum already bounds agentName to configured
    // tool agents, but a tool argument is never trusted implicitly.
    if (!agent) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown native agent: ${agentName}` }],
      };
    }

    const credential = credentials[agent.accountId];
    if (!credential) {
      console.warn(
        `[native-agent-executor] missing credential for account "${agent.accountId}" ` +
          `(agent "${agentName}"); failing closed`,
      );
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "This agent's provider account is not configured. Ask the owner to connect it in Settings.",
        }],
      };
    }

    try {
      const result = await executor.execute(
        { agentName, systemPrompt: agent.prompt, userInput: input, model: agent.model },
        credential,
        signal,
      );
      usageCollector.record(result.usage);
      console.log(`[native-agent-executor] agent=${agentName} provider=openrouter model=${result.usage.model} status=ok`);
      return { content: [{ type: "text" as const, text: result.text }] };
    } catch (err) {
      const kind = err instanceof NativeAgentExecutorError ? err.kind : "network";
      console.error(
        `[native-agent-executor] agent=${agentName} provider=openrouter model=${agent.model} status=error kind=${kind}`,
        err instanceof NativeAgentExecutorError ? err.cause ?? err.message : err,
      );
      return {
        isError: true,
        content: [{ type: "text" as const, text: nativeAgentFailureMessage(kind) }],
      };
    }
  };
}

/**
 * Builds the "matrix-os-agents" in-process MCP server exposing
 * `invoke_native_agent`, using Matrix's existing createSdkMcpServer()+tool()
 * pattern (see kernel/ipc-server.ts). Returns null when there are no
 * OpenRouter-routed agents this session, so options.ts can skip wiring an
 * empty server.
 */
export async function createNativeAgentToolServer(
  options: CreateNativeAgentToolServerOptions,
) {
  const { toolAgents, credentials, usageCollector, signal, executor = createOpenRouterExecutor() } = options;
  const agentNames = Object.keys(toolAgents);
  if (agentNames.length === 0) return null;

  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod/v4");
  const handler = buildInvokeNativeAgentHandler(options);

  return createSdkMcpServer({
    name: "matrix-os-agents",
    tools: [
      tool(
        "invoke_native_agent",
        "Invoke a provider-neutral native Matrix agent routed to a non-Anthropic backend " +
          "(currently OpenRouter) instead of Task. Only use this for the agent names listed " +
          "here -- other native agents still use Task. The agent receives `input` as its task " +
          "and returns one text result; it has no file, Bash, or IPC tool access in this version.",
        {
          agentName: z.enum(agentNames as [string, ...string[]]).describe("Name of a configured OpenRouter-routed native agent"),
          input: z.string().min(1).max(20_000).describe("The task for the agent to perform"),
        },
        handler,
      ),
    ],
  });
}
