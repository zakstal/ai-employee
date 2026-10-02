import { describe, expect, it } from "vitest";
import { BOT_MARKER, chatTrigger } from "./chat.js";

describe("chatTrigger", () => {
  it("parses a flat v3-like message", () => {
    const t = chatTrigger({ id: "m1", channel_id: "ch1", content: "hello bot", user_id: 42 });
    expect(t).toEqual({ taskId: "clickup-chat:ch1:m1", channelId: "ch1", messageId: "m1", text: "hello bot", userId: "42" });
  });
  it("parses a nested payload", () => {
    const t = chatTrigger({ event: "message_posted", payload: { message: { id: "m2", text: "  what is up  ", channel: { id: "ch2" }, user: { id: "7" } } } });
    expect(t?.taskId).toBe("clickup-chat:ch2:m2");
    expect(t?.text).toBe("what is up");
  });
  it("parses the real ClickUp Chat Automation payload", () => {
    const real = {
      auto_id: "757a0b38-969d-4c4c-acf8-4378eba4aa04:long_running",
      trigger_id: "1b59dc8b-5003-4a63-b1e7-5b4299f6d2fc",
      date: "2026-09-14T15:06:14.074Z",
      payload: { object_id: "90000000000001", status: "found", data: { id: "90000000000001", date: "1789398372493", parent: "chan-abc123", type: 8, userid: 12345678, resolved: false, root_parent_id: "chan-abc123", root_parent_type: 8, referenced_content: "", is_private: false, text_content: "hello\n" } },
    };
    expect(chatTrigger(real)).toEqual({ taskId: "clickup-chat:chan-abc123:90000000000001", channelId: "chan-abc123", messageId: "90000000000001", text: "hello", userId: "12345678" });
  });
  it("ignores bot replies (loop guard) and empty text", () => {
    expect(chatTrigger({ id: "m3", channel_id: "ch1", content: `${BOT_MARKER}I am the bot` })).toBeUndefined();
    expect(chatTrigger({ id: "m4", channel_id: "ch1", content: "   " })).toBeUndefined();
  });
  it("returns undefined without a channel", () => {
    expect(chatTrigger({ id: "m5", content: "no channel here" })).toBeUndefined();
  });
});
