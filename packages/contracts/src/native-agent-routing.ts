import { z } from "zod/v4";
import { ProviderModelReferenceSchema, SAFE_SLUG } from "#contract-primitives";

/**
 * Provider-neutral per-agent model routing (MAT issue #1534).
 *
 * This is deliberately separate from `#agent-runtime-config` (which governs
 * the whole-Chat/whole-messaging-runtime driver such as Hermes vs. OpenClaw).
 * `NativeAgentRoutingSchema` governs routing for one native agent (builder,
 * researcher, healer, evolver, or a custom `~/agents/custom/*.md` agent)
 * *inside* a single Claude Agent SDK kernel session.
 *
 * v1 supports exactly three providers:
 *  - "inherit"    -- use the parent kernel session's own model/backend (default)
 *  - "anthropic"  -- Claude Agent SDK `Task`/subagent path, unchanged
 *  - "openrouter" -- provider-neutral in-process MCP tool executor path
 *
 * Codex, OpenCode, Pi, and any Settings UI surface are explicitly out of
 * scope for v1; the enum is intentionally narrow rather than open-ended so
 * an invalid/unknown provider string fails schema validation instead of
 * silently matching a future value.
 */
export const NativeAgentProviderSchema = z.enum(["inherit", "anthropic", "openrouter"]);

const NativeAgentAccountIdSchema = z.string().regex(SAFE_SLUG).max(80);

export const NativeAgentEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const NativeAgentRoutingSchema = z.object({
  provider: NativeAgentProviderSchema,
  /** Access-source/account reference, e.g. "owner_openrouter". Never a secret. */
  accountId: NativeAgentAccountIdSchema.nullable(),
  model: ProviderModelReferenceSchema.nullable(),
  effort: NativeAgentEffortSchema.nullable(),
}).strict().superRefine((routing, ctx) => {
  if (routing.provider === "inherit") {
    if (routing.accountId !== null) {
      ctx.addIssue({ code: "custom", path: ["accountId"], message: "inherit routing cannot set accountId" });
    }
    if (routing.model !== null) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "inherit routing cannot set model" });
    }
  }
  if (routing.provider === "openrouter") {
    if (routing.accountId === null) {
      ctx.addIssue({ code: "custom", path: ["accountId"], message: "openrouter routing requires accountId" });
    }
    if (routing.model === null) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "openrouter routing requires model" });
    }
  }
  // "anthropic" routing may set model (full model ID or alias) with no
  // accountId (single implicit Anthropic backend for the whole session);
  // an accountId here would imply multi-account Anthropic routing, which is
  // out of scope for v1.
  if (routing.provider === "anthropic" && routing.accountId !== null) {
    ctx.addIssue({ code: "custom", path: ["accountId"], message: "anthropic routing cannot set accountId in v1" });
  }
});

export type NativeAgentProvider = z.infer<typeof NativeAgentProviderSchema>;
export type NativeAgentEffort = z.infer<typeof NativeAgentEffortSchema>;
export type NativeAgentRouting = z.infer<typeof NativeAgentRoutingSchema>;

/** The routing every agent without an explicit `routing:` block resolves to. */
export const INHERIT_NATIVE_AGENT_ROUTING: NativeAgentRouting = {
  provider: "inherit",
  accountId: null,
  model: null,
  effort: null,
};
