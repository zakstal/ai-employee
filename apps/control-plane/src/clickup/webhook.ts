/**
 * ClickUp webhook → TaskInput. Pure; the HTTP layer calls this after signature
 * verification. Returns undefined when the event is not a trigger.
 *
 * Triggers:
 *  - taskCommentPosted whose text contains the trigger word (default "!<employeeId>"; "@" collides with ClickUp's mention picker) and
 *    was not written by the bot user itself (loop guard).
 *  - taskAssigneeUpdated where the bot user id is among the added assignees.
 */
export interface ClickUpWebhook {
  event: string;
  webhook_id?: string;
  task_id?: string;
  history_items?: Array<{
    id?: string;
    field?: string;
    user?: { id?: number | string; username?: string };
    after?: unknown;
    before?: unknown;
    comment?: { id?: string; text_content?: string; user?: { id?: number | string; username?: string } };
  }>;
}

export interface ClickUpTriggerOpts {
  employeeId: string;
  triggerWord?: string;
  botUserId?: string;
}

export interface ClickUpTrigger {
  taskId: string; // ledger/workflow id
  clickupTaskId: string;
  prompt: string;
  requestedBy?: string;
}

import { BOT_MARKER } from "./chat.js";

export function clickUpTrigger(body: ClickUpWebhook, opts: ClickUpTriggerOpts): ClickUpTrigger | undefined {
  const clickupTaskId = body.task_id;
  if (!clickupTaskId) return undefined;
  const trigger = (opts.triggerWord ?? `!${opts.employeeId}`).toLowerCase();

  if (body.event === "taskCommentPosted") {
    const item = body.history_items?.find((h) => h.comment) ?? body.history_items?.[0];
    const text = item?.comment?.text_content?.trim() ?? "";
    const author = String(item?.comment?.user?.id ?? item?.user?.id ?? "");
    if (!text.toLowerCase().includes(trigger)) return undefined;
    // Loop guards: our own replies start with BOT_MARKER (needed while the bot posts as a human user),
    // and a dedicated bot user is ignored outright.
    if (text.startsWith(BOT_MARKER.trim())) return undefined;
    if (opts.botUserId && author === opts.botUserId) return undefined;
    const commentId = item?.comment?.id ?? String(item?.after ?? item?.id ?? "");
    return {
      taskId: `clickup:${clickupTaskId}:comment:${commentId || hash(text)}`,
      clickupTaskId,
      prompt: text.replace(new RegExp(escapeRe(trigger), "ig"), "").trim(),
      ...(item?.comment?.user?.username ? { requestedBy: item.comment.user.username } : {}),
    };
  }

  if (body.event === "taskAssigneeUpdated" && opts.botUserId) {
    const item = body.history_items?.find((h) => String((h.after as { id?: unknown } | undefined)?.id ?? "") === opts.botUserId);
    if (!item) return undefined;
    return {
      taskId: `clickup:${clickupTaskId}:assigned:${item.id ?? "0"}`,
      clickupTaskId,
      prompt: "You have been assigned this task. Do it, or explain what is blocking you.",
    };
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hash(s: string): string {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16);
}
