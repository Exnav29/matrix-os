import { describe, expect, it, vi } from "vitest";
import { authorizeChatTerminalAttach } from "../../packages/gateway/src/chat/terminal-authorization.js";

const owner = { type: "personal" as const, ownerId: "user_a" };

describe("Chat terminal attach authorization", () => {
  it("requires an exact persisted binding and a live attachable session", async () => {
    const hasTerminalBinding = vi.fn(async () => true);
    const get = vi.fn(async () => ({ name: "terminal_bound", status: "active", recoverable: false }));

    await expect(authorizeChatTerminalAttach({
      repository: { hasTerminalBinding },
      registry: { get },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(true);
    expect(hasTerminalBinding).toHaveBeenCalledWith(owner, "chat_selected", "terminal_bound");
    expect(get).toHaveBeenCalledWith("terminal_bound");
  });

  it("rejects foreign or unbound Chat sessions before the live lookup", async () => {
    const get = vi.fn();

    await expect(authorizeChatTerminalAttach({
      repository: { hasTerminalBinding: vi.fn(async () => false) },
      registry: { get },
      owner,
      chatId: "chat_foreign",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { name: "terminal_bound", status: "exited", recoverable: false },
    { name: "terminal_bound", status: "active", recoverable: true },
    { name: "terminal_renamed", status: "active", recoverable: false },
  ])("rejects unavailable live state %#", async (session) => {
    await expect(authorizeChatTerminalAttach({
      repository: { hasTerminalBinding: vi.fn(async () => true) },
      registry: { get: vi.fn(async () => session) },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
  });

  it("fails closed on invalid identifiers and dependency errors", async () => {
    await expect(authorizeChatTerminalAttach({
      repository: { hasTerminalBinding: vi.fn(async () => { throw new Error("private database failure"); }) },
      registry: { get: vi.fn() },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
    await expect(authorizeChatTerminalAttach({
      repository: { hasTerminalBinding: vi.fn(async () => true) },
      registry: { get: vi.fn() },
      owner,
      chatId: "not a chat id",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
  });
});
