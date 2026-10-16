import { describe, expect, it } from "vitest";
import { telegramTrigger } from "./update.js";

const allowed = { allowedChatIds: ["111"] };
const msg = (over: Record<string, unknown> = {}, chat: Record<string, unknown> = {}) => ({
  update_id: 900,
  message: { message_id: 5, text: "  hello  ", chat: { id: 111, type: "private", ...chat }, from: { id: 111 }, ...over },
});

describe("telegramTrigger", () => {
  it("parses a private text message", () => {
    expect(telegramTrigger(msg(), allowed)).toEqual({ taskId: "telegram:900", updateId: 900, chatId: "111", messageId: "5", text: "hello" });
  });
  it("ignores chats that are not allowlisted", () => {
    expect(telegramTrigger(msg({}, { id: 222 }), allowed)).toEqual({ ignored: "chat 222 not allowlisted" });
    expect(telegramTrigger(msg(), { allowedChatIds: [] })).toMatchObject({ ignored: expect.stringContaining("not allowlisted") });
  });
  it("ignores non-message updates, non-text messages, group chats and junk", () => {
    expect(telegramTrigger({ update_id: 1, edited_message: { message_id: 1 } }, allowed)).toEqual({ ignored: "not a message update" });
    expect(telegramTrigger(msg({ text: undefined, photo: [{}] }), allowed)).toEqual({ ignored: "no text" });
    expect(telegramTrigger(msg({ text: "   " }), allowed)).toEqual({ ignored: "no text" });
    expect(telegramTrigger(msg(), { allowedChatIds: ["111"] })).toHaveProperty("taskId");
    expect(telegramTrigger(msg({}, { type: "group" }), allowed)).toEqual({ ignored: "not a private chat" });
    expect(telegramTrigger({ nope: true }, allowed)).toEqual({ ignored: "unparseable update" });
    expect(telegramTrigger("x", allowed)).toEqual({ ignored: "unparseable update" });
  });
});
