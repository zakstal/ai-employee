export interface TelegramClient {
  /** Returns the new message id. */
  sendMessage(chatId: string, text: string): Promise<string>;
  editMessageText(chatId: string, messageId: string, text: string): Promise<void>;
}

const API = "https://api.telegram.org";

/** One Bot API call. The token sits in the URL path, so errors never echo the URL. */
export async function telegramCall<T = unknown>(token: string, method: string, body: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch, base = API): Promise<T> {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN unset");
  const res = await fetchImpl(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !json.ok) throw new Error(`telegram ${method} → ${res.status} ${(json.description ?? "").slice(0, 200)}`);
  return json.result as T;
}

/** Plain text only: no parse_mode, so nothing needs escaping. */
export class HttpTelegramClient implements TelegramClient {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch, private base = API) {}

  async sendMessage(chatId: string, text: string): Promise<string> {
    const r = await telegramCall<{ message_id?: number }>(this.token, "sendMessage", { chat_id: chatId, text }, this.fetchImpl, this.base);
    return String(r?.message_id ?? "");
  }

  async editMessageText(chatId: string, messageId: string, text: string): Promise<void> {
    await telegramCall(this.token, "editMessageText", { chat_id: chatId, message_id: Number(messageId), text }, this.fetchImpl, this.base);
  }
}

export class NoopTelegramClient implements TelegramClient {
  messages: { id: string; chatId: string; text: string }[] = [];
  private n = 0;
  async sendMessage(chatId: string, text: string): Promise<string> {
    const id = `t${++this.n}`;
    this.messages.push({ id, chatId, text });
    return id;
  }
  async editMessageText(_chatId: string, messageId: string, text: string): Promise<void> {
    const m = this.messages.find((x) => x.id === messageId);
    if (m) m.text = text;
  }
}
