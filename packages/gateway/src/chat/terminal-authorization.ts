import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { validateSessionName } from "../shell/names.js";
import type { ChatOwner } from "./records.js";

export async function authorizeChatTerminalAttach(input: {
  repository: {
    hasTerminalBinding(owner: ChatOwner, chatId: string, sessionId: string): Promise<boolean>;
  };
  registry: { get(name: string): Promise<unknown> };
  owner: ChatOwner;
  chatId: string;
  sessionId: string;
}): Promise<boolean> {
  try {
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const sessionId = validateSessionName(input.sessionId);
    if (!await input.repository.hasTerminalBinding(input.owner, chatId, sessionId)) return false;
    const session = await input.registry.get(sessionId);
    if (!session || typeof session !== "object") return false;
    const candidate = session as { name?: unknown; status?: unknown; recoverable?: unknown };
    return candidate.name === sessionId
      && candidate.status === "active"
      && candidate.recoverable !== true;
  } catch (err: unknown) {
    console.warn(
      "[chat] terminal attach authorization failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
