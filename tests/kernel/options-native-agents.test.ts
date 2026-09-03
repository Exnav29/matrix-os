import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixDB } from "../../packages/kernel/src/db.js";

const agentsMock = vi.hoisted(() => ({
  getCoreAgents: vi.fn(() => ({
    builder: { description: "builds", prompt: "build stuff", model: "opus" },
  })),
  loadCustomAgents: vi.fn(() => ({} as Record<string, unknown>)),
}));

vi.mock("../../packages/kernel/src/ipc-server.js", () => ({
  createIpcServer: vi.fn(async () => ({ name: "matrix-os-ipc" })),
}));
vi.mock("../../packages/kernel/src/agents.js", () => agentsMock);
vi.mock("../../packages/kernel/src/prompt.js", () => ({
  buildSystemPrompt: vi.fn(() => "base system prompt"),
}));
vi.mock("../../packages/kernel/src/skills.js", () => ({
  ensureSdkSkillsMirror: vi.fn(),
}));
vi.mock("../../packages/kernel/src/hooks.js", () => ({
  safetyGuardHook: vi.fn(),
  updateStateHook: vi.fn(),
  logActivityHook: vi.fn(),
  createGitSnapshotHook: vi.fn(() => vi.fn()),
  persistSessionHook: vi.fn(),
  onSubagentComplete: vi.fn(),
  notifyShellHook: vi.fn(),
  preCompactHook: vi.fn(),
}));
vi.mock("../../packages/kernel/src/evolution.js", () => ({
  createProtectedFilesHook: vi.fn(() => vi.fn()),
}));

import { kernelOptions, type KernelConfig } from "../../packages/kernel/src/options.js";

describe("kernelOptions -- provider-neutral native-agent routing (MAT #1534)", () => {
  const db = {} as MatrixDB;
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "kernel-native-agents-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
    agentsMock.getCoreAgents.mockReturnValue({
      builder: { description: "builds", prompt: "build stuff", model: "opus" },
    });
    agentsMock.loadCustomAgents.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("with no routing configured anywhere, agents/mcpServers/allowedTools are unchanged from legacy behavior", async () => {
    const config: KernelConfig = { db, homePath };
    const options = await kernelOptions(config);

    expect(options.agents).toEqual({
      builder: { description: "builds", prompt: "build stuff", model: "opus" },
    });
    expect(Object.keys(options.mcpServers)).toEqual(["matrix-os-ipc"]);
    expect(options.allowedTools).not.toContain("mcp__matrix-os-agents__invoke_native_agent");
    expect(options.systemPrompt).toBe("base system prompt"); // no directory blurb appended
  });

  it("an openrouter-routed custom agent is absent from options.agents and present via the tool server", async () => {
    agentsMock.loadCustomAgents.mockReturnValue({
      researcher: {
        description: "researches things",
        prompt: "You research.",
        routing: { provider: "openrouter", accountId: "owner_openrouter", model: "anthropic/claude-3.5-sonnet", effort: null },
      },
    });
    writeFileSync(
      join(homePath, "system", "config.json"),
      JSON.stringify({ nativeAgents: { accounts: { owner_openrouter: { apiKey: "sk-or-test-key" } } } }),
    );

    const config: KernelConfig = { db, homePath };
    const options = await kernelOptions(config);

    expect(options.agents.researcher).toBeUndefined();
    expect(options.agents.builder).toBeDefined();
    expect(Object.keys(options.mcpServers).sort()).toEqual(["matrix-os-agents", "matrix-os-ipc"]);
    expect(options.allowedTools).toContain("mcp__matrix-os-agents__invoke_native_agent");
    expect(options.systemPrompt).toContain("researcher");
    expect(options.systemPrompt).toContain("invoke_native_agent");
  });

  it("does not build the native-agent tool server (or read config.json for credentials) when no agent uses openrouter routing", async () => {
    // No system/config.json write in this test -- if kernelOptions tried to
    // resolve native-agent credentials it would still handle a missing file
    // gracefully, but this proves the whole path is skipped when unused.
    const config: KernelConfig = { db, homePath };
    const options = await kernelOptions(config);
    expect(Object.keys(options.mcpServers)).toEqual(["matrix-os-ipc"]);
  });

  it("an existing caller passing only config (no extra param) still works -- kernelOptions(config) signature is backward compatible", async () => {
    const config: KernelConfig = { db, homePath };
    await expect(kernelOptions(config)).resolves.toBeDefined();
  });
});
