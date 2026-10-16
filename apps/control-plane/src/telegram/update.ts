import { z } from "zod";

/** Only the fields we use; Telegram sends many more. */
const Update = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      text: z.string().optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
    })
    .optional(),
});

export interface TelegramTrigger {
  taskId: string;
  updateId: number;
  chatId: string;
  messageId: string;
  text: string;
}

/** A trigger, or the reason the update is ignored (the route logs it and still answers 200 so Telegram does not retry). */
export function telegramTrigger(body: unknown, opts: { allowedChatIds: string[] }): TelegramTrigger | { ignored: string } {
  const u = Update.safeParse(body);
  if (!u.success) return { ignored: "unparseable update" };
  const m = u.data.message;
  if (!m) return { ignored: "not a message update" };
  const chatId = String(m.chat.id);
  // Allowlist first: a stranger learns nothing, not even that the bot is alive.
  if (!opts.allowedChatIds.includes(chatId)) return { ignored: `chat ${chatId} not allowlisted` };
  if (m.chat.type !== "private") return { ignored: "not a private chat" };
  const text = m.text?.trim();
  if (!text) return { ignored: "no text" };
  return { taskId: `telegram:${u.data.update_id}`, updateId: u.data.update_id, chatId, messageId: String(m.message_id), text };
}
