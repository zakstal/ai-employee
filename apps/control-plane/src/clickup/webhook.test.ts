import { describe, expect, it } from "vitest";
import { clickUpTrigger } from "./webhook.js";

const opts = { employeeId: "dev", botUserId: "999" };

describe("clickUpTrigger", () => {
  it("fires on a comment mentioning the bot and strips the mention", () => {
    const t = clickUpTrigger(
      { event: "taskCommentPosted", task_id: "abc", history_items: [{ comment: { id: "c1", text_content: "!dev please check the build", user: { id: 1, username: "alice" } } }] },
      opts,
    );
    expect(t).toEqual({ taskId: "clickup:abc:comment:c1", clickupTaskId: "abc", prompt: "please check the build", requestedBy: "alice" });
  });
  it("ignores comments without the trigger and comments by the bot itself", () => {
    expect(clickUpTrigger({ event: "taskCommentPosted", task_id: "abc", history_items: [{ comment: { id: "c2", text_content: "unrelated" } }] }, opts)).toBeUndefined();
    expect(clickUpTrigger({ event: "taskCommentPosted", task_id: "abc", history_items: [{ comment: { id: "c3", text_content: "!dev done", user: { id: 999 } } }] }, opts)).toBeUndefined();
  });
  it("ignores the bot's own marked replies even when they quote the trigger word", () => {
    expect(clickUpTrigger({ event: "taskCommentPosted", task_id: "abc", history_items: [{ comment: { id: "c4", text_content: "\u{1F916} Done. Comment with !dev again if needed.", user: { id: 1 } } }] }, opts)).toBeUndefined();
  });
  it("fires when the bot is assigned", () => {
    const t = clickUpTrigger({ event: "taskAssigneeUpdated", task_id: "abc", history_items: [{ id: "h1", after: { id: 999 } }] }, opts);
    expect(t?.taskId).toBe("clickup:abc:assigned:h1");
  });
  it("ignores other events", () => {
    expect(clickUpTrigger({ event: "taskStatusUpdated", task_id: "abc" }, opts)).toBeUndefined();
  });
});
