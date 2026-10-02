/**
 * ClickUp Chat Automation → "Call webhook" payload. Field names are NOT documented,
 * so this parser is tolerant: it hunts for message text, author, channel and message
 * ids across the plausible shapes. Unknown shapes still get logged raw by the route.
 */
export const BOT_MARKER = "\u{1F916} "; // "🤖 " — every bot reply starts with it; incoming messages starting with it are ignored (loop guard)

export interface ChatTrigger {
  taskId: string;
  channelId: string;
  messageId: string;
  text: string;
  userId?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Depth-first search for the first object that looks like a chat message. */
function findMessage(v: unknown, depth = 0): Obj | undefined {
  if (depth > 6) return undefined;
  if (isObj(v)) {
    const hasText = typeof v.content === "string" || typeof v.text === "string" || typeof v.text_content === "string" || typeof v.message === "string";
    const hasChan = v.channel_id !== undefined || v.parent !== undefined || isObj(v.channel) || v.channelId !== undefined;
    if (hasText && (hasChan || v.id !== undefined)) return v;
    for (const val of Object.values(v)) {
      const hit = findMessage(val, depth + 1);
      if (hit) return hit;
    }
  } else if (Array.isArray(v)) {
    for (const item of v) {
      const hit = findMessage(item, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

export function chatTrigger(body: unknown, opts: { botUserId?: string } = {}): ChatTrigger | undefined {
  const root = isObj(body) ? body : {};
  const m = findMessage(body) ?? root;
  const text = (str(m.content) ?? str(m.text) ?? str(m.text_content) ?? str(m.message) ?? "").trim();
  if (!text) return undefined;
  if (text.startsWith(BOT_MARKER.trim())) return undefined;

  // Real Chat Automation payload (observed 2026-09-14): { auto_id, trigger_id, date, payload: { object_id, status,
  // data: { id, date, parent: "<channel id>", type: 8, userid, text_content: "hello\n", root_parent_id, ... } } }
  const parent = typeof m.parent === "string" ? m.parent : str((m.parent as Obj | undefined)?.id);
  const channelId =
    str(m.channel_id) ?? str(m.channelId) ?? str((m.channel as Obj | undefined)?.id) ?? parent ?? str(m.root_parent_id) ?? str(root.channel_id) ?? str((root.channel as Obj | undefined)?.id);
  if (!channelId) return undefined;
  const messageId = str(m.id) ?? str(m.message_id) ?? str(root.id) ?? `${Date.now()}`;
  const userId = str(m.user_id) ?? str((m.user as Obj | undefined)?.id) ?? str(m.userid) ?? str((root.user as Obj | undefined)?.id);
  if (opts.botUserId && userId === opts.botUserId && text.startsWith(BOT_MARKER.trim())) return undefined;

  return { taskId: `clickup-chat:${channelId}:${messageId}`, channelId, messageId, text, ...(userId ? { userId } : {}) };
}
