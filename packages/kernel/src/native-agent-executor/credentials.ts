import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeAgentCredential } from "./types.js";

/**
 * Resolves in-memory-only credentials for OpenRouter-routed native agents
 * (MAT #1534), for the accounts actually referenced by this session's
 * toolAgents -- never for the whole provider catalog, and never eagerly for
 * homes that configure no OpenRouter routing at all.
 *
 * KNOWN LIMITATION (documented rather than worked around with an unsafe
 * shortcut, per implementation instructions): upstream `main` does not yet
 * ship an owner-facing OpenRouter credential persistence/Settings flow.
 * `packages/gateway/src/ai-providers/service.ts` models an "owner_openrouter"
 * access source/account for display purposes, but
 * `packages/gateway/src/ai-providers/credential-store.ts` only resolves
 * Anthropic kernel credentials -- there is no owner OpenRouter key storage
 * to read yet. Spec 118-ai-gateway-provider-auth tracks the real
 * persistence/OAuth path as future work.
 *
 * Until that lands, this resolver mirrors the same bounded pattern already
 * used in this exact package for other server-side API keys --
 * ipc-server.ts's loadWebConfig() for BRAVE_API_KEY / PERPLEXITY_API_KEY /
 * XAI_API_KEY:
 *   1. `~/system/config.json` -> `nativeAgents.accounts[accountId]`, an
 *      owner-editable file entry that may hold a literal key or a
 *      `${ENV_VAR}` indirection -- never required to hold a raw secret.
 *   2. For the well-known "owner_openrouter" account id specifically, fall
 *      back to `process.env.OPENROUTER_API_KEY` when no config entry
 *      exists -- a real, deployable development/UAT seam, not a
 *      plaintext-file shortcut.
 * A base URL override is validated via the gateway's existing SSRF-safe
 * `validateProviderBaseUrl` (dynamically imported, same cross-package
 * pattern kernel/ipc-server.ts already uses for other `@matrix-os/gateway`
 * subpaths). A missing/invalid credential simply is not included in the
 * returned map -- callers (createNativeAgentToolServer) fail that one
 * agent's tool call closed; they never fall back to another backend.
 */

interface NativeAgentAccountConfig {
  apiKey?: unknown;
  baseUrl?: unknown;
}

function resolveEnvIndirection(value: string): string | undefined {
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) return process.env[match[1]] || undefined;
  return value;
}

async function readConfiguredAccount(
  homePath: string,
  accountId: string,
): Promise<NativeAgentAccountConfig | undefined> {
  try {
    const raw = await readFile(join(homePath, "system", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    const account = config?.nativeAgents?.accounts?.[accountId];
    return account && typeof account === "object" ? (account as NativeAgentAccountConfig) : undefined;
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        "[native-agent-credentials] failed to read system/config.json:",
        err instanceof Error ? err.name : "UnknownError",
      );
    }
    return undefined;
  }
}

async function resolveOneCredential(
  homePath: string,
  accountId: string,
): Promise<NativeAgentCredential | undefined> {
  const configured = await readConfiguredAccount(homePath, accountId);

  let apiKey: string | undefined;
  if (typeof configured?.apiKey === "string" && configured.apiKey.length > 0) {
    apiKey = resolveEnvIndirection(configured.apiKey);
  } else if (accountId === "owner_openrouter") {
    apiKey = process.env.OPENROUTER_API_KEY || undefined; // documented dev/UAT seam, see module docstring
  }
  if (!apiKey) return undefined;

  let baseUrl: string | undefined;
  if (typeof configured?.baseUrl === "string" && configured.baseUrl.length > 0) {
    const resolved = resolveEnvIndirection(configured.baseUrl);
    if (!resolved) return undefined;
    try {
      const { validateProviderBaseUrl } = await import("@matrix-os/gateway/agent-config/base-url-policy");
      await validateProviderBaseUrl(resolved);
    } catch (err) {
      console.warn(
        `[native-agent-credentials] rejected base URL for account "${accountId}":`,
        err instanceof Error ? err.name : "UnknownError",
      );
      return undefined;
    }
    baseUrl = resolved;
  }

  return baseUrl ? { apiKey, baseUrl } : { apiKey };
}

/**
 * Resolves credentials only for the given accountIds. Accounts that fail to
 * resolve are simply absent from the returned map -- one owner's
 * misconfigured OpenRouter account never throws or takes down the rest of
 * the kernel spawn; it only makes that account's agents fail closed.
 */
export async function resolveNativeAgentCredentials(
  homePath: string,
  accountIds: readonly string[],
): Promise<Record<string, NativeAgentCredential>> {
  const uniqueIds = [...new Set(accountIds)];
  const resolved: Record<string, NativeAgentCredential> = {};

  await Promise.all(uniqueIds.map(async (accountId) => {
    const credential = await resolveOneCredential(homePath, accountId);
    if (credential) resolved[accountId] = credential;
  }));

  return resolved;
}
