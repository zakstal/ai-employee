export interface TaskListItem {
  id: string;
  title: string;
  phase: number;
  checked: boolean;
  /** Item ids this one waits for. */
  depends: string[];
}

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Markdown task list:
 *   ## Phase 1 — primitives
 *   - [ ] Button
 *   - [x] Badge
 *   - [ ] Input <!-- depends: Button, Badge -->
 * Items before any phase heading are phase 1. Item id = slug of its text.
 */
export function parseTaskList(md: string): TaskListItem[] {
  const out: TaskListItem[] = [];
  let phase = 1;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+Phase\s+(\d+)/i.exec(line);
    if (h) {
      phase = Number(h[1]);
      continue;
    }
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    let text = m[2]!;
    let depends: string[] = [];
    const d = /<!--\s*depends:\s*(.*?)\s*-->/.exec(text);
    if (d) {
      depends = d[1]!.split(",").map(slug).filter(Boolean);
      text = text.replace(d[0], "").trim();
    }
    out.push({ id: slug(text), title: text, phase, checked: m[1] !== " ", depends });
  }
  return out;
}
