#!/usr/bin/env node
// Leak guard: denylist terms + blocked file types. Usage:
//   node scripts/leak-check.mjs            scan the whole working tree (tracked + untracked, not git-ignored)
//   node scripts/leak-check.mjs --diff <base>   scan only lines/files added in <base>...HEAD
// Hits are failures unless an entry in scripts/leak-allowlist.json ({path, match, reason}) covers path AND line.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const here = (f) => new URL(f, import.meta.url);
import { homedir } from "node:os";
import { existsSync } from "node:fs";
// Public generic terms + private terms that must never be committed (env var / file outside the repo).
const termLines = (t) => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const privateFile = process.env.LEAK_DENYLIST_FILE || `${homedir()}/.config/ai-employee/leak-denylist.txt`;
const terms = [
  ...termLines(readFileSync(here("leak-denylist.txt"), "utf8")),
  ...termLines(process.env.LEAK_DENYLIST || ""),
  ...(existsSync(privateFile) ? termLines(readFileSync(privateFile, "utf8")) : []),
];
if (!process.env.LEAK_DENYLIST && !existsSync(privateFile))
  console.warn(`leak-check: no private denylist (set LEAK_DENYLIST or create ${privateFile}); checking generic terms only`);
const deny = new RegExp(terms.join("|"), "i");
const allow = JSON.parse(readFileSync(here("leak-allowlist.json"), "utf8"));
for (const a of allow) if (!a.path || !a.match || !a.reason) throw new Error(`allowlist entry needs path, match, reason: ${JSON.stringify(a)}`);
// The guard's own config necessarily names the terms; they are exempt from content scanning (review changes to them closely).
const SELF = new Set(["scripts/leak-check.mjs", "scripts/leak-denylist.txt", "scripts/leak-allowlist.json", ".gitleaks.toml"]);

const BLOCKED = [
  [/\.tfstate/, "terraform state"],
  [/\.tfplan$/, "terraform plan"],
  [/\.tfvars$/, "tfvars (use *.tfvars.example)"],
  [/(^|\/)\.env(\.|$)(?!example$)/, ".env file (use .env.example)"],
  [/\.pyc$/, "python bytecode"],
  [/(^|\/)__pycache__\//, "__pycache__"],
  [/(^|\/)\.terraform\//, ".terraform dir"],
];

const diffIdx = process.argv.indexOf("--diff");
const base = diffIdx > 0 ? process.argv[diffIdx + 1] : null;
if (diffIdx > 0 && !base) throw new Error("--diff needs a base ref");

const lines = []; // {path, n, text}
let paths;
if (base) {
  paths = git("diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`).split("\n").filter(Boolean);
  let path = "", n = 0;
  for (const l of git("diff", "-U0", "--no-color", "--diff-filter=ACMR", `${base}...HEAD`).split("\n")) {
    if (l.startsWith("+++ b/")) path = l.slice(6);
    else if (l.startsWith("@@")) n = Number(/\+(\d+)/.exec(l)[1]) - 1;
    else if (l.startsWith("+") && !l.startsWith("+++")) lines.push({ path, n: ++n, text: l.slice(1) });
  }
} else {
  paths = git("ls-files", "-co", "--exclude-standard", "-z").split("\0").filter(Boolean);
  for (const path of paths) {
    let buf;
    try { buf = readFileSync(path); } catch { continue; }
    if (buf.includes(0)) continue;
    buf.toString("utf8").split("\n").forEach((text, i) => lines.push({ path, n: i + 1, text }));
  }
}

const globRe = (g) => new RegExp("^" + g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const allowed = (path, text) => allow.some((a) => globRe(a.path).test(path) && new RegExp(a.match, "i").test(text));

const fails = [];
for (const p of paths) {
  for (const [re, why] of BLOCKED) if (re.test(p)) fails.push(`${p}: blocked file type (${why})`);
  if (!SELF.has(p) && deny.test(p) && !allowed(p, p)) fails.push(`${p}: path matches denylist`);
}
for (const { path, n, text } of lines) {
  if (SELF.has(path) || !deny.test(text) || allowed(path, text)) continue;
  fails.push(`${path}:${n}: denylisted term: ${text.trim().slice(0, 160)}`);
}
if (fails.length) {
  console.error(fails.join("\n"));
  console.error(`\nleak-check FAILED: ${fails.length} hit(s)`);
  process.exit(1);
}
console.log(`leak-check ok (${base ? `diff vs ${base}` : "whole tree"}: ${paths.length} files, ${lines.length} lines)`);
