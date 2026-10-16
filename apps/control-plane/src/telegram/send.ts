import type { TelegramClient } from "./client.js";

export const TELEGRAM_LIMIT = 4096;
export const TELEGRAM_ACK_TEXT = "…";

/** Split on a newline (else a space, else hard) so every chunk fits Telegram's message limit. */
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
    const at = cut > limit / 2 ? cut : limit;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

/** The first chunk replaces the placeholder when there is one (a new message if the edit fails); the rest are new messages. */
export async function deliverTelegram(client: TelegramClient, chatId: string, text: string, placeholderId?: string): Promise<void> {
  const [first, ...more] = splitMessage(text.trim() || TELEGRAM_ACK_TEXT);
  if (placeholderId) await client.editMessageText(chatId, placeholderId, first!).catch(() => client.sendMessage(chatId, first!));
  else await client.sendMessage(chatId, first!);
  for (const chunk of more) await client.sendMessage(chatId, chunk);
}
