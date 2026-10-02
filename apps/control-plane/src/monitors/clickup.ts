import type { ClickUpClient } from "../clickup/client.js";
import { BOT_MARKER } from "../clickup/chat.js";
import type { CollectResult, Finding } from "./types.js";

/** New human messages in the configured ClickUp chat channels since the last run. First run only sets cursors. */
export interface ClickUpChannelsConfig {
  channels?: Array<{ id: string; name?: string }>;
  limit?: number;
}
interface ClickUpState {
  initialized?: boolean;
  lastId?: Record<string, string>;
}

const asNum = (id: string) => Number(id.replace(/\D/g, "")) || 0;

export async function collectClickUpChannels(
  config: ClickUpChannelsConfig,
  clickup: ClickUpClient,
  workspaceId: string,
  prevState: Record<string, unknown>,
): Promise<CollectResult> {
  const prev = prevState as ClickUpState;
  const lastId: Record<string, string> = { ...(prev.lastId ?? {}) };
  const findings: Finding[] = [];
  for (const ch of config.channels ?? []) {
    const msgs = await clickup.getChannelMessages(workspaceId, ch.id, config.limit ?? 25).catch(() => []);
    const sorted = msgs.slice().sort((a, b) => asNum(a.id) - asNum(b.id));
    const cursor = lastId[ch.id];
    for (const m of sorted) {
      if (cursor !== undefined && asNum(m.id) <= asNum(cursor)) continue;
      if (prev.initialized && cursor !== undefined && m.text.trim() && !m.text.startsWith(BOT_MARKER.trim())) {
        findings.push({
          key: `clickup|${ch.id}|${m.id}`,
          text: `#${ch.name ?? ch.id}${m.userId ? ` user ${m.userId}` : ""}: ${m.text.trim().slice(0, 400)}`,
          evidence: {
            source: `ClickUp chat #${ch.name ?? ch.id} (channel ${ch.id})`,
            observed: `message ${m.id}${m.userId ? ` from user ${m.userId}` : ""}`,
            url: `https://app.clickup.com/${workspaceId}/v/cn/${ch.id}/t/${m.id}`,
          },
        });
      }
    }
    const newest = sorted.at(-1)?.id;
    if (newest !== undefined) lastId[ch.id] = newest;
  }
  return { findings, state: { initialized: true, lastId } satisfies ClickUpState as Record<string, unknown> };
}
