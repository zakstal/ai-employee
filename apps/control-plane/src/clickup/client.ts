export interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  url?: string;
  status?: { status: string };
}

export interface ChatMessage {
  id: string;
  text: string;
  userId?: string;
  date?: string;
}

export interface ClickUpClient {
  getTask(taskId: string): Promise<ClickUpTask>;
  /** Every task of a list, closed ones included (paged). */
  listTasks(listId: string): Promise<ClickUpTask[]>;
  postComment(taskId: string, text: string): Promise<string>;
  /** v3 Chat (experimental API). Newest first as returned by ClickUp. */
  getChannelMessages(workspaceId: string, channelId: string, limit: number): Promise<ChatMessage[]>;
  /** Returns the new message id. */
  postChannelMessage(workspaceId: string, channelId: string, text: string): Promise<string>;
  updateChannelMessage(workspaceId: string, messageId: string, text: string): Promise<void>;
  addReaction(workspaceId: string, messageId: string, reaction: string): Promise<void>;
  /** v2 task comments. postComment returns the comment id. */
  updateComment(commentId: string, text: string): Promise<void>;
}

/** Personal tokens (pk_...) go in `Authorization` raw, no Bearer prefix. */
export class HttpClickUpClient implements ClickUpClient {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch, private base = "https://api.clickup.com/api/v2") {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error("CLICKUP_API_TOKEN unset");
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { authorization: this.token, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`clickup ${init.method ?? "GET"} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  getTask(taskId: string): Promise<ClickUpTask> {
    return this.call<ClickUpTask>(`/task/${encodeURIComponent(taskId)}`);
  }

  async listTasks(listId: string): Promise<ClickUpTask[]> {
    const out: ClickUpTask[] = [];
    for (let page = 0; page < 20; page++) {
      const r = await this.call<{ tasks?: ClickUpTask[]; last_page?: boolean }>(`/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=true&page=${page}`);
      out.push(...(r.tasks ?? []));
      if (r.last_page !== false) break; // ClickUp sets last_page on the final page
    }
    return out;
  }

  async postComment(taskId: string, text: string): Promise<string> {
    const r = await this.call<{ id?: string | number }>(`/task/${encodeURIComponent(taskId)}/comment`, { method: "POST", body: JSON.stringify({ comment_text: text, notify_all: false }) });
    return String(r.id ?? "");
  }

  async updateComment(commentId: string, text: string): Promise<void> {
    await this.call(`/comment/${encodeURIComponent(commentId)}`, { method: "PUT", body: JSON.stringify({ comment_text: text }) });
  }

  private v3(path: string): string {
    return `${this.base.replace(/\/v2$/, "/v3")}${path}`;
  }

  async getChannelMessages(workspaceId: string, channelId: string, limit: number): Promise<ChatMessage[]> {
    const res = await this.fetchImpl(this.v3(`/workspaces/${workspaceId}/chat/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}&content_format=text/plain`), {
      headers: { authorization: this.token },
    });
    if (!res.ok) throw new Error(`clickup GET chat messages → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return (body.data ?? []).map((m) => ({
      id: String(m.id ?? ""),
      text: String(m.content ?? m.text ?? ""),
      userId: m.user_id !== undefined ? String(m.user_id) : (m.user as { id?: unknown } | undefined)?.id !== undefined ? String((m.user as { id: unknown }).id) : undefined,
      date: m.date !== undefined ? String(m.date) : undefined,
    })) as ChatMessage[];
  }

  async postChannelMessage(workspaceId: string, channelId: string, text: string): Promise<string> {
    const res = await this.fetchImpl(this.v3(`/workspaces/${workspaceId}/chat/channels/${encodeURIComponent(channelId)}/messages`), {
      method: "POST",
      headers: { authorization: this.token, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", content_format: "text/md", content: text }),
    });
    if (!res.ok) throw new Error(`clickup POST chat message → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { id?: string }; id?: string };
    return String(body.data?.id ?? body.id ?? "");
  }

  async updateChannelMessage(workspaceId: string, messageId: string, text: string): Promise<void> {
    const res = await this.fetchImpl(this.v3(`/workspaces/${workspaceId}/chat/messages/${encodeURIComponent(messageId)}`), {
      method: "PATCH",
      headers: { authorization: this.token, "content-type": "application/json" },
      body: JSON.stringify({ content_format: "text/md", content: text }),
    });
    if (!res.ok) throw new Error(`clickup PATCH chat message → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  async addReaction(workspaceId: string, messageId: string, reaction: string): Promise<void> {
    const res = await this.fetchImpl(this.v3(`/workspaces/${workspaceId}/chat/messages/${encodeURIComponent(messageId)}/reactions`), {
      method: "POST",
      headers: { authorization: this.token, "content-type": "application/json" },
      body: JSON.stringify({ reaction }),
    });
    if (!res.ok && res.status !== 409) throw new Error(`clickup POST reaction → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export class NoopClickUpClient implements ClickUpClient {
  comments: { id: string; taskId: string; text: string }[] = [];
  tasks = new Map<string, ClickUpTask>();
  reactions: { messageId: string; reaction: string }[] = [];
  private n = 0;
  async getTask(taskId: string): Promise<ClickUpTask> {
    return this.tasks.get(taskId) ?? { id: taskId, name: `Task ${taskId}` };
  }
  listed = new Map<string, ClickUpTask[]>();
  async listTasks(listId: string): Promise<ClickUpTask[]> {
    return this.listed.get(listId) ?? [];
  }
  async postComment(taskId: string, text: string): Promise<string> {
    const id = `c${++this.n}`;
    this.comments.push({ id, taskId, text });
    return id;
  }
  async updateComment(commentId: string, text: string): Promise<void> {
    const c = this.comments.find((x) => x.id === commentId);
    if (c) c.text = text;
  }
  history = new Map<string, ChatMessage[]>();
  chatMessages: { id: string; channelId: string; text: string }[] = [];
  async getChannelMessages(_w: string, channelId: string, limit: number): Promise<ChatMessage[]> {
    return (this.history.get(channelId) ?? []).slice(0, limit);
  }
  async postChannelMessage(_w: string, channelId: string, text: string): Promise<string> {
    const id = `m${++this.n}`;
    this.chatMessages.push({ id, channelId, text });
    return id;
  }
  async updateChannelMessage(_w: string, messageId: string, text: string): Promise<void> {
    const m = this.chatMessages.find((x) => x.id === messageId);
    if (m) m.text = text;
  }
  async addReaction(_w: string, messageId: string, reaction: string): Promise<void> {
    this.reactions.push({ messageId, reaction });
  }
}
