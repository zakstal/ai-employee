import { z } from "zod";
import { collectClickUpChannels, type ClickUpChannelsConfig } from "../monitors/clickup.js";
import type { Collector } from "./types.js";

const schema = z
  .object({ channels: z.array(z.object({ id: z.string(), name: z.string().optional() }).passthrough()).optional(), limit: z.number().optional() })
  .passthrough();

export const clickupChannels: Collector<z.infer<typeof schema>> = {
  id: "clickup-channels",
  configSchema: schema,
  collect: (ctx, config, prev) => collectClickUpChannels(config as ClickUpChannelsConfig, ctx.clickup, ctx.config.CLICKUP_TEAM_ID, prev),
};
