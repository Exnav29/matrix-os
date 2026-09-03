import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCustomAgents, getCoreAgents, SAFE_CLAUDE_MODEL_ID } from "../../packages/kernel/src/agents.js";

function makeAgentsDir(): string {
  return mkdtempSync(join(tmpdir(), "matrix-agents-routing-"));
}

function writeAgent(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf-8");
}

describe("legacy agent behavior (no explicit routing)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is unchanged: model/tools/maxTurns parse exactly as before, no routing field present", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "legacy.md",
      `---
name: legacy
description: A legacy agent with no routing config
model: sonnet
maxTurns: 10
tools:
  - Read
---
Legacy prompt body.`,
    );

    const agents = loadCustomAgents(dir);
    expect(agents.legacy).toBeDefined();
    expect(agents.legacy.model).toBe("sonnet");
    expect(agents.legacy.maxTurns).toBe(10);
    expect(agents.legacy.tools).toEqual(["Read"]);
    expect(agents.legacy.routing).toBeUndefined();
  });

  it("core agents are untouched -- still five agents, no routing field, same models", () => {
    const agents = getCoreAgents("/test/matrixos");
    expect(Object.keys(agents)).toEqual(["builder", "healer", "researcher", "deployer", "evolver"]);
    for (const agent of Object.values(agents)) {
      expect(agent.routing).toBeUndefined();
    }
    expect(agents.builder.model).toBe("opus");
    expect(agents.researcher.model).toBe("haiku");
  });
});

describe("full Claude model ID support (SDK-spike-confirmed widening)", () => {
  it("SAFE_CLAUDE_MODEL_ID accepts real full model IDs", () => {
    expect(SAFE_CLAUDE_MODEL_ID.test("claude-opus-5")).toBe(true);
    expect(SAFE_CLAUDE_MODEL_ID.test("claude-fable-5")).toBe(true);
    expect(SAFE_CLAUDE_MODEL_ID.test("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("SAFE_CLAUDE_MODEL_ID rejects unsafe/malformed values", () => {
    expect(SAFE_CLAUDE_MODEL_ID.test("not-a-model")).toBe(false);
    expect(SAFE_CLAUDE_MODEL_ID.test("claude-../../etc/passwd")).toBe(false);
    expect(SAFE_CLAUDE_MODEL_ID.test("")).toBe(false);
  });

  it("a legacy agent may specify a full Claude model ID instead of an alias", () => {
    const dir = makeAgentsDir();
    try {
      writeAgent(
        dir,
        "full-id.md",
        `---
name: full-id
description: Uses a full model ID, not an alias
model: claude-fable-5
---
Prompt.`,
      );
      const agents = loadCustomAgents(dir);
      expect(agents["full-id"].model).toBe("claude-fable-5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("explicit routing: valid configurations are honored", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("provider: inherit with no account/model parses to inherit routing", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "inherit.md",
      `---
name: inherit-agent
description: Explicit inherit
provider: inherit
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents["inherit-agent"].routing).toEqual({
      provider: "inherit",
      accountId: null,
      model: null,
      effort: null,
    });
  });

  it("provider: anthropic with a model is honored", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "anthropic.md",
      `---
name: anthropic-agent
description: Explicit anthropic routing
provider: anthropic
model: claude-opus-5
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents["anthropic-agent"].routing).toEqual({
      provider: "anthropic",
      accountId: null,
      model: "claude-opus-5",
      effort: null,
    });
  });

  it("provider: openrouter with account + model is honored", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "openrouter.md",
      `---
name: or-agent
description: Explicit openrouter routing
provider: openrouter
account: owner_openrouter
model: anthropic/claude-3.5-sonnet
effort: high
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents["or-agent"].routing).toEqual({
      provider: "openrouter",
      accountId: "owner_openrouter",
      model: "anthropic/claude-3.5-sonnet",
      effort: "high",
    });
  });
});

describe("explicit routing: invalid configurations fail that agent closed", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("openrouter routing missing accountId excludes the agent entirely (never inherits Anthropic)", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "bad-or.md",
      `---
name: bad-or
description: Missing account
provider: openrouter
model: anthropic/claude-3.5-sonnet
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents["bad-or"]).toBeUndefined();
    expect(Object.keys(agents)).toEqual([]);
  });

  it("openrouter routing missing model excludes the agent entirely", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "bad-or2.md",
      `---
name: bad-or2
description: Missing model
provider: openrouter
account: owner_openrouter
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents["bad-or2"]).toBeUndefined();
  });

  it("unknown provider value excludes the agent entirely", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "bad-provider.md",
      `---
name: bad-provider
description: Unknown provider
provider: codex
model: some-model
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents["bad-provider"]).toBeUndefined();
  });

  it("inherit routing with a model set is contradictory and excludes the agent", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "bad-inherit.md",
      `---
name: bad-inherit
description: Contradictory inherit+model
provider: inherit
model: opus
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents["bad-inherit"]).toBeUndefined();
  });

  it("an invalid-routing agent does not affect other, validly-configured agents in the same directory", () => {
    dir = makeAgentsDir();
    writeAgent(
      dir,
      "bad.md",
      `---
name: bad
description: invalid
provider: openrouter
---
Prompt.`,
    );
    writeAgent(
      dir,
      "good.md",
      `---
name: good
description: valid inherit
provider: inherit
---
Prompt.`,
    );
    const agents = loadCustomAgents(dir);
    expect(agents.bad).toBeUndefined();
    expect(agents.good).toBeDefined();
    expect(agents.good.routing?.provider).toBe("inherit");
  });
});
