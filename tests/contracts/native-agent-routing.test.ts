import { describe, expect, it } from "vitest";
import {
  NativeAgentRoutingSchema,
  NativeAgentProviderSchema,
  INHERIT_NATIVE_AGENT_ROUTING,
} from "@matrix-os/contracts";

describe("NativeAgentProviderSchema", () => {
  it("accepts exactly the v1 providers", () => {
    for (const value of ["inherit", "anthropic", "openrouter"]) {
      expect(NativeAgentProviderSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects out-of-scope providers (Codex/OpenCode/Pi are not v1)", () => {
    for (const value of ["codex", "opencode", "pi", "bedrock", ""]) {
      expect(NativeAgentProviderSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("NativeAgentRoutingSchema", () => {
  it("accepts the canonical inherit shape", () => {
    expect(NativeAgentRoutingSchema.safeParse(INHERIT_NATIVE_AGENT_ROUTING).success).toBe(true);
  });

  it("accepts anthropic routing with a model and no accountId", () => {
    const result = NativeAgentRoutingSchema.safeParse({
      provider: "anthropic",
      accountId: null,
      model: "claude-opus-5",
      effort: "high",
    });
    expect(result.success).toBe(true);
  });

  it("accepts anthropic routing with no model (falls through to session default)", () => {
    const result = NativeAgentRoutingSchema.safeParse({
      provider: "anthropic",
      accountId: null,
      model: null,
      effort: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts openrouter routing with accountId, model, and an org/model-slug reference", () => {
    const result = NativeAgentRoutingSchema.safeParse({
      provider: "openrouter",
      accountId: "owner_openrouter",
      model: "anthropic/claude-3.5-sonnet",
      effort: "medium",
    });
    expect(result.success).toBe(true);
  });

  it("rejects inherit routing with a non-null accountId or model", () => {
    expect(NativeAgentRoutingSchema.safeParse({ provider: "inherit", accountId: "x", model: null, effort: null }).success).toBe(false);
    expect(NativeAgentRoutingSchema.safeParse({ provider: "inherit", accountId: null, model: "opus", effort: null }).success).toBe(false);
  });

  it("rejects openrouter routing missing accountId or model", () => {
    expect(NativeAgentRoutingSchema.safeParse({ provider: "openrouter", accountId: null, model: "m/x", effort: null }).success).toBe(false);
    expect(NativeAgentRoutingSchema.safeParse({ provider: "openrouter", accountId: "a", model: null, effort: null }).success).toBe(false);
  });

  it("rejects anthropic routing that sets an accountId (out of scope for v1)", () => {
    const result = NativeAgentRoutingSchema.safeParse({
      provider: "anthropic",
      accountId: "some_account",
      model: "claude-opus-5",
      effort: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown provider value entirely", () => {
    const result = NativeAgentRoutingSchema.safeParse({
      provider: "codex",
      accountId: null,
      model: null,
      effort: null,
    });
    expect(result.success).toBe(false);
  });

  it("is strict -- rejects unknown extra fields", () => {
    const result = NativeAgentRoutingSchema.safeParse({
      provider: "inherit",
      accountId: null,
      model: null,
      effort: null,
      apiKey: "sk-or-should-never-be-here",
    });
    expect(result.success).toBe(false);
  });
});
