export interface SlackClient {
  postMessage(msg: { channel: string; text: string; thread_ts?: string }): Promise<void>;
}

export class HttpSlackClient implements SlackClient {
  constructor(private botToken: string, private fetchImpl: typeof fetch = fetch) {}
  async postMessage(msg: { channel: string; text: string; thread_ts?: string }): Promise<void> {
    if (!this.botToken) return; // unconfigured: no-op so local dev works without Slack
    const res = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${this.botToken}` },
      body: JSON.stringify(msg),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) throw new Error(`slack chat.postMessage failed: ${body.error ?? res.status}`);
  }
}

export class NoopSlackClient implements SlackClient {
  sent: { channel: string; text: string; thread_ts?: string }[] = [];
  async postMessage(msg: { channel: string; text: string; thread_ts?: string }): Promise<void> {
    this.sent.push(msg);
  }
}
