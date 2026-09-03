import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNativeAgentCredentials } from "../../packages/kernel/src/native-agent-executor/credentials.js";

describe("resolveNativeAgentCredentials", () => {
  let homePath: string;
  const originalEnv = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "native-agent-creds-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalEnv;
  });

  function writeConfig(obj: unknown) {
    writeFileSync(join(homePath, "system", "config.json"), JSON.stringify(obj));
  }

  it("resolves nothing (fails closed) when no accountIds are requested", async () => {
    const result = await resolveNativeAgentCredentials(homePath, []);
    expect(result).toEqual({});
  });

  it("resolves nothing for an account with no config entry and no env fallback (missing credential fails closed)", async () => {
    const result = await resolveNativeAgentCredentials(homePath, ["owner_openrouter"]);
    expect(result).toEqual({});
  });

  it("resolves a literal apiKey from system/config.json", async () => {
    writeConfig({ nativeAgents: { accounts: { owner_openrouter: { apiKey: "sk-or-literal" } } } });
    const result = await resolveNativeAgentCredentials(homePath, ["owner_openrouter"]);
    expect(result.owner_openrouter).toEqual({ apiKey: "sk-or-literal" });
  });

  it("resolves ${ENV_VAR} indirection from system/config.json without storing the raw secret in the file", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-from-env";
    writeConfig({ nativeAgents: { accounts: { owner_openrouter: { apiKey: "${OPENROUTER_API_KEY}" } } } });
    const result = await resolveNativeAgentCredentials(homePath, ["owner_openrouter"]);
    expect(result.owner_openrouter).toEqual({ apiKey: "sk-or-from-env" });
  });

  it("falls back to process.env.OPENROUTER_API_KEY for the well-known owner_openrouter account (documented dev/UAT seam)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-fallback";
    const result = await resolveNativeAgentCredentials(homePath, ["owner_openrouter"]);
    expect(result.owner_openrouter).toEqual({ apiKey: "sk-or-fallback" });
  });

  it("does NOT apply the env fallback to an unrelated account id", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-fallback";
    const result = await resolveNativeAgentCredentials(homePath, ["some_other_account"]);
    expect(result.some_other_account).toBeUndefined();
  });

  it("resolves only the requested account ids, not every account in the file", async () => {
    writeConfig({
      nativeAgents: {
        accounts: {
          owner_openrouter: { apiKey: "sk-or-a" },
          another_account: { apiKey: "sk-or-b" },
        },
      },
    });
    const result = await resolveNativeAgentCredentials(homePath, ["owner_openrouter"]);
    expect(Object.keys(result)).toEqual(["owner_openrouter"]);
  });

  it("rejects an invalid (non-HTTPS) base URL and fails that account closed", async () => {
    writeConfig({
      nativeAgents: {
        accounts: {
          owner_openrouter: { apiKey: "sk-or-a", baseUrl: "http://openrouter.internal/v1" },
        },
      },
    });
    const result = await resolveNativeAgentCredentials(homePath, ["owner_openrouter"]);
    expect(result.owner_openrouter).toBeUndefined();
  });

  it("accepts a valid HTTPS base URL override", async () => {
    writeConfig({
      nativeAgents: {
        accounts: {
          owner_openrouter: { apiKey: "sk-or-a", baseUrl: "https://openrouter.ai/api/v1" },
        },
      },
    });
    const result = await resolveNativeAgentCredentials(homePath, ["owner_openrouter"]);
    expect(result.owner_openrouter).toEqual({ apiKey: "sk-or-a", baseUrl: "https://openrouter.ai/api/v1" });
  });

  it("does not throw on malformed config.json -- fails closed for all requested accounts", async () => {
    writeFileSync(join(homePath, "system", "config.json"), "{not json");
    await expect(resolveNativeAgentCredentials(homePath, ["owner_openrouter"])).resolves.toEqual({});
  });
});
