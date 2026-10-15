/** Minimal GitHub REST helpers for the control plane's own reads (backlog state, collectors). */
export async function ghGet(f: typeof fetch, token: string | undefined, path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const res = await f(`https://api.github.com${path}`, {
    headers: { accept, "user-agent": "ai-employee", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`github GET ${path} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res;
}

/** All pages (100 each, capped at 10) of a list endpoint. */
export async function ghList<T>(f: typeof fetch, token: string | undefined, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = (await (await ghGet(f, token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)).json()) as T[];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
