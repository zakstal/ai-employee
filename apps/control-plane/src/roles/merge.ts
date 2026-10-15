/**
 * Role inheritance on RAW yaml objects (before schema defaults fill in). A child key is one of:
 *   key   replaces a scalar or list, merges a map (mcpServers, by server name)
 *   +key  appends to the inherited list (deduped, order kept)
 *   -key  removes entries from the inherited list (repos match on url), or server names from mcpServers
 * `extends` and the prefixed keys never reach the Role schema.
 */
type Raw = Record<string, unknown>;

const LISTS = new Set(["allowedTools", "disallowedTools", "credentials", "repos", "capabilities", "canSchedule", "canSpawn", "systemPromptFiles"]);
const MAPS = new Set(["mcpServers"]);
const key = (x: unknown) => (x && typeof x === "object" && "url" in x ? String((x as { url: unknown }).url) : JSON.stringify(x));
const arr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`${what} must be a list`);
  return v;
};

function filesOf(r: Raw): unknown[] | undefined {
  return (r.systemPromptFiles as unknown[] | undefined) ?? (typeof r.systemPromptFile === "string" ? [r.systemPromptFile] : undefined);
}

export function mergeRole(parent: Raw, child: Raw): Raw {
  const out: Raw = { ...parent };
  const pfiles = filesOf(parent);
  const touched = (f: string) => [f, `+${f}`, `-${f}`].some((k) => k in child);
  for (const [k, v] of Object.entries(child)) {
    const name = k.replace(/^[+-]/, "");
    if (k === "extends" || k === "systemPromptFile" || k === "systemPromptFiles" || name === "systemPromptFiles") continue;
    if (LISTS.has(name)) {
      const base = (out[name] as unknown[] | undefined) ?? [];
      if (k.startsWith("+")) out[name] = [...base, ...arr(v, k).filter((x) => !base.some((b) => key(b) === key(x)))];
      else if (k.startsWith("-")) out[name] = base.filter((b) => !arr(v, k).some((x) => key(x) === key(b)));
      else out[name] = arr(v, k);
    } else if (MAPS.has(name)) {
      const base = (out[name] as Raw | undefined) ?? {};
      if (k.startsWith("-")) out[name] = Object.fromEntries(Object.entries(base).filter(([n]) => !arr(v, k).includes(n)));
      else out[name] = { ...base, ...(v as Raw) };
    } else {
      out[name] = v;
    }
  }
  // Prompt files: the legacy single `systemPromptFile` is a one-element list.
  if (touched("systemPromptFiles")) {
    const base = pfiles ?? [];
    let list = base;
    if (Array.isArray(child.systemPromptFiles)) list = child.systemPromptFiles;
    if (Array.isArray(child["+systemPromptFiles"])) list = [...list, ...(child["+systemPromptFiles"] as unknown[]).filter((x) => !list.includes(x))];
    if (Array.isArray(child["-systemPromptFiles"])) list = list.filter((x) => !(child["-systemPromptFiles"] as unknown[]).includes(x));
    delete out.systemPromptFile;
    out.systemPromptFiles = list;
  } else if (typeof child.systemPromptFile === "string") {
    delete out.systemPromptFiles;
    out.systemPromptFile = child.systemPromptFile;
  }
  return out;
}

const MAX_DEPTH = 5;

/**
 * Resolve every role of a file. `base` holds roles from `use` bundles (the layer below); a file role with the
 * same id patches the bundle role. `extends: <id>` names another role of the file or of the bundles.
 * Roles whose id starts with `_` are abstract: usable as parents, dropped from the result.
 */
export function resolveRoles(own: Raw[], base: Raw[]): Raw[] {
  const find = (list: Raw[], id: string) => list.find((r) => r.id === id);
  const resolve = (layer: "own" | "base", role: Raw, stack: string[]): Raw => {
    const id = String(role.id);
    const tag = `${layer}:${id}`;
    if (stack.includes(tag)) throw new Error(`role ${id}: extends cycle (${[...stack, tag].join(" -> ")})`);
    if (stack.length >= MAX_DEPTH) throw new Error(`role ${id}: extends deeper than ${MAX_DEPTH}`);
    let parent: Raw = {};
    if (typeof role.extends === "string") {
      const pid = role.extends;
      const p = find(own, pid) ?? find(base, pid);
      if (!p) throw new Error(`role ${id}: extends unknown role ${pid}`);
      parent = resolve(own.includes(p) ? "own" : "base", p, [...stack, tag]);
    } else if (layer === "own" && find(base, id)) {
      parent = resolve("base", find(base, id)!, [...stack, tag]);
    }
    return { ...mergeRole(parent, role), id };
  };
  const ids = new Set(own.map((r) => String(r.id)));
  const all = [...base.filter((r) => !ids.has(String(r.id))).map((r) => resolve("base", r, [])), ...own.map((r) => resolve("own", r, []))];
  return all.filter((r) => !String(r.id).startsWith("_"));
}

const VAR = /\{\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}\}/g;

/** Substitute `{{NAME}}` / `{{NAME:-default}}`; an unknown name without a default is an error. */
export function substitute(text: string, vars: Record<string, string>, roleId: string): string {
  return text.replace(VAR, (_m, name: string, dflt: string | undefined) => {
    const v = vars[name] ?? dflt;
    if (v === undefined) throw new Error(`role ${roleId}: prompt uses {{${name}}} but no var ${name}`);
    return v;
  });
}
