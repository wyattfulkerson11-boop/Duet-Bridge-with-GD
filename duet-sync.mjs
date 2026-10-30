// duet-sync: copy one checked project summary into a Google Drive folder that Claude Duet reads.
// `setup` registers a project. `push` checks .duet/DUET-CONTEXT.md, then copies it. Everything is
// checked before anything is written, and problems are named, never echoed, because this file is
// about to leave the machine. Exit codes: 0 done, 1 refused (nothing written), 2 write failed.

import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `usage: duet-sync.mjs setup [--drive PATH] [--folder NAME] [--scan PATH]... [--replace]
       duet-sync.mjs push
`;

const WORKING_FILE = ".duet/DUET-CONTEXT.md";
const HEADINGS = ["The problem", "Who does what", "Rules", "What's built", "Open items", "What I need back"];
const CONTEXT_MAX = 8 * 1024;
const SOURCE_MAX = 1024 * 1024;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$/;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 60000;

// Folders that hold other people's files, not this project's secrets. `.env` is here as a folder
// because it's a common virtualenv name; a file named .env is still scanned.
const SKIP_DIRS = new Set([".git", ".duet", ".env", ".venv", "venv", "node_modules", "vendor", "dist", "build", "out", "target", ".next", ".nuxt", ".cache", "__pycache__"]);
const SECRET_FILE = /^\.(env|dev\.vars)(\..+)?$/;
const CREDENTIAL_KEY = /secret|token|pass|pwd|key|auth|cred|private|signature|dsn|session|cookie/i;

// shortcut: known shapes only, so a credential in an unknown format gets through. The value scan
// and the skill's own rules cover some of that; the README calls the gate best-effort.
const CREDENTIAL_PATTERNS = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, "a connection string with a password"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/, "a GitLab token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}/, "a Google API key"],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bhooks\.slack\.com\/services\/\S+|\bdiscord(?:app)?\.com\/api\/webhooks\/\S+/i, "a webhook URL"],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{10,}/, "a Stripe key"],
  [/\bnpm_[A-Za-z0-9]{30,}/, "an npm token"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, "a SendGrid key"],
  [/\bnfp_[A-Za-z0-9]{20,}/, "a Netlify token"],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}/, "a Telegram bot token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JSON web token"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, "a bearer token"],
];

// Link parameters that carry a credential, compared lowercase with - and _ removed.
const TOKEN_KEYS = new Set(["key", "sig", "code", "auth", "jwt", "bearer"]);
const TOKEN_SUFFIX = /(token|secret|password|passwd|apikey|signature|credentials?)$/;

class Refused extends Error {
  constructor(problems) {
    super("refused");
    this.problems = [...new Set(problems)];
  }
}

/** Git's output, or null when it fails or isn't installed. */
function git(dir, ...args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Where this project is, and the id it's registered under: worktrees share their main repo's. */
function findProject(cwd) {
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (top === null) {
    const root = realpathSync(cwd);
    return { root, id: root, isGit: false, name: basename(root) };
  }
  const id = realpathSync(resolve(top, git(top, "rev-parse", "--git-common-dir")));
  return { root: top, id, isGit: true, name: basename(id) === ".git" ? basename(dirname(id)) : basename(top) };
}

const configDir = () => join(homedir(), ".config/duet-bridge");
const configPath = () => join(configDir(), "config.json");

function loadConfig() {
  if (!existsSync(configPath())) return { version: 1, drive: null, projects: {} };
  try {
    const config = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof config.projects === "object" && config.projects !== null) return config;
  } catch { /* reported below */ }
  throw new Refused([`${configPath()} is not valid. Fix or delete it, then run setup again.`]);
}

function saveConfig(config) {
  mkdirSync(configDir(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, configPath());
}

function kind(path) {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

function findDrive() {
  const cloud = join(homedir(), "Library/CloudStorage");
  const accounts = existsSync(cloud) ? readdirSync(cloud).filter((n) => n.startsWith("GoogleDrive-")).map((n) => join(cloud, n, "My Drive")) : [];
  const found = [...accounts, join(homedir(), "My Drive")].filter((p) => existsSync(p));
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Refused(["no Google Drive folder found. Is Google Drive for desktop installed and signed in? Otherwise pass --drive PATH."]);
  throw new Refused([`more than one Google Drive folder found. Pick one with --drive PATH:\n${found.map((p) => `      ${p}`).join("\n")}`]);
}

function realDrive(path) {
  try {
    const real = realpathSync(path);
    if (statSync(real).isDirectory()) return real;
  } catch { /* reported below */ }
  throw new Refused([`${path} is missing`]);
}

function checkGitState(project) {
  if (git(project.root, "ls-files", "--", ".duet")) return [".duet is tracked by git. Remove it from git yourself, then run this again."];
  if (git(project.root, "check-ignore", "-q", "--", WORKING_FILE) === null) return [".duet is not git-ignored. Something in .gitignore re-includes it."];
  return [];
}

/** Add `/.duet/` to git's local exclude file. Never touches .gitignore. */
function excludeWorkingFolder(project) {
  const path = resolve(project.root, git(project.root, "rev-parse", "--git-path", "info/exclude"));
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.split("\n").includes("/.duet/")) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${text && !text.endsWith("\n") ? "\n" : ""}/.duet/\n`);
}

function setup(argv) {
  const { values: flags } = parseArgs({ args: argv, options: {
    drive: { type: "string" }, folder: { type: "string" }, scan: { type: "string", multiple: true }, replace: { type: "boolean" },
  } });
  const config = loadConfig();
  const project = findProject(process.cwd());
  const current = config.projects[project.id];

  const folder = flags.folder ?? current?.folder ?? project.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 41);
  if (!FOLDER.test(folder)) throw new Refused([`folder "${folder.slice(0, 60)}" must be one plain name (letters, digits, spaces, _ or -). Pick one with --folder.`]);

  const drive = realDrive(flags.drive ?? config.drive ?? findDrive());
  if (!relative(realpathSync(project.root), drive).startsWith("..")) throw new Refused([`${drive} is inside this project, so the summary would land in your repo. Pass your real Drive folder.`]);
  const duet = join(drive, "Duet");
  const duetKind = kind(duet);
  if (duetKind && duetKind !== "dir") throw new Refused([`Duet is a ${duetKind === "symlink" ? "symlink" : "file"}. It has to be a real folder.`]);

  for (const [id, other] of Object.entries(config.projects)) {
    if (id !== project.id && other.folder.toLowerCase() === folder.toLowerCase()) throw new Refused([`folder "${folder}" is already used by ${id}. Pick another with --folder.`]);
  }
  if (current?.folder !== folder && kind(join(duet, folder, "DUET-CONTEXT.md")) && !flags.replace) {
    throw new Refused([`Duet/${folder} already holds a context file. Pick another --folder, or pass --replace to overwrite it on the next push.`]);
  }

  const scan = [...(current?.scan ?? [])];
  for (const path of flags.scan ?? []) {
    const abs = resolve(project.root, path);
    if (!existsSync(abs)) throw new Refused([`${path} is missing`]);
    if (!scan.includes(abs)) scan.push(abs);
  }

  if (project.isGit) {
    const tracked = git(project.root, "ls-files", "--", ".duet");
    if (tracked) throw new Refused(checkGitState(project));
    excludeWorkingFolder(project);
    const problems = checkGitState(project);
    if (problems.length) throw new Refused(problems);
  }
  mkdirSync(duet, { recursive: true });
  mkdirSync(join(project.root, ".duet"), { recursive: true });
  saveConfig({ ...config, drive, projects: { ...config.projects, [project.id]: { folder, scan } } });
  process.stdout.write(`duet: set up. Write ${WORKING_FILE}, then run push. It will go to ${join(duet, folder)}\n`);
}

function shapeProblems(text) {
  const out = HEADINGS.filter((h) => !new RegExp(`^## ${h}(?=[ (]|$)`, "m").test(text)).map((h) => `missing heading "## ${h}"`);
  if (!/\bas of\s+\d{4}-\d{2}-\d{2}\b/i.test(text)) out.push(`no "as of YYYY-MM-DD" line`);
  return out;
}

/** Links that carry a credential: userinfo, or a query or fragment key that names one. */
function linkProblems(text) {
  const out = new Set();
  // Parens and brackets stay in: a `)` mid-link must not hide the query after it. Sentence
  // punctuation at the end comes off, or "http://localhost:3000." wouldn't parse.
  for (const [raw] of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    let url;
    // A link the parser rejects could still carry a token, so it fails closed.
    try { url = new URL(raw.replace(/[.,;:!?)\]]+$/, "")); } catch { out.add("a link that cannot be parsed"); continue; }
    if (url.username || url.password) out.add("a link with a user:password");
    for (const key of [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]) {
      const name = key.toLowerCase().replace(/[-_]/g, "");
      if (TOKEN_KEYS.has(name) || TOKEN_SUFFIX.test(name)) out.add(`a link with a ${key.toLowerCase()}= parameter`);
    }
  }
  return [...out];
}

function looksPublic(value) {
  return /\s/.test(value) || /^[.~]?\//.test(value) || (/^https?:\/\//i.test(value) && linkProblems(value).length === 0);
}

/** shortcut: length and key name decide what counts, so a short unlabeled secret is missed. */
function isSecret(key, value) {
  return CREDENTIAL_KEY.test(key) ? value.length >= 8 : value.length >= 12 && !looksPublic(value);
}

/** Values worth searching for in the file. Assignments anywhere; whole lines in `.private`. */
function secretValues(text, path, wholeLines) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*#?\s*(?:export\s+)?["']?([\w.-]+)["']?\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m) {
      // A quoted value ends at its closing quote; an unquoted one at a ` #` comment.
      const quoted = /^(["'])(.*?)\1/.exec(m[2]);
      const value = (quoted ? quoted[2] : m[2].replace(/\s+#.*$/, "")).trim();
      if (isSecret(m[1], value)) out.push({ name: `${m[1]} from ${path}`, value });
      // The summary could quote the password without the rest of the URL. Local development
      // URLs are skipped: their password is usually a plain word like "postgres".
      const url = /:\/\/[^\s/:@]*:([^\s/@]+)@([^\s/:?#]+)/.exec(value);
      if (url && url[1].length >= 8 && !/^(localhost|127\.0\.0\.1)$/i.test(url[2])) out.push({ name: `${m[1]}'s password from ${path}`, value: url[1] });
    }
    if (wholeLines && line.trim().length >= 8) out.push({ name: `line ${i + 1} of ${path}`, value: line.trim() });
  });
  return out;
}

/** Every secret source in the project. A source that can't be checked is a problem, not a skip. */
function findSources(root, problems) {
  const found = [];
  const walk = (dir, insidePrivate) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      problems.push(`${relative(root, dir) || "the project"} is unreadable`);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      const isSource = insidePrivate || entry.name === ".private" || SECRET_FILE.test(entry.name);
      if (entry.isSymbolicLink()) {
        if (!isSource) continue;
        let st;
        try { st = statSync(path); } catch { problems.push(`${rel} is a broken symlink`); continue; }
        if (st.isDirectory()) problems.push(`${rel} is a symlinked folder`);
        else found.push({ path, label: rel, wholeLines: insidePrivate });
      } else if (entry.isDirectory()) {
        if (entry.name === ".private" || insidePrivate) walk(path, true);
        else if (!SKIP_DIRS.has(entry.name)) walk(path, false);
      } else if (entry.isFile() && isSource) {
        found.push({ path, label: rel, wholeLines: insidePrivate });
      }
    }
  };
  walk(root, false);
  return found;
}

function readSource({ path, label }, problems) {
  try {
    const st = statSync(path);
    if (st.size >= SOURCE_MAX) { problems.push(`${label} is 1 MB or more`); return null; }
    return readFileSync(path, "utf8");
  } catch (e) {
    problems.push(e.code === "ENOENT" ? `${label} is missing` : `${label} is unreadable`);
    return null;
  }
}

function readContext(project, problems) {
  const path = join(project.root, WORKING_FILE);
  const found = kind(path);
  if (!found) problems.push(`${WORKING_FILE} is missing`);
  else if (found === "symlink") problems.push(`${WORKING_FILE} is a symlink`);
  else if (found !== "file") problems.push(`${WORKING_FILE} is not a regular file`);
  else if (lstatSync(path).size >= CONTEXT_MAX) problems.push("DUET-CONTEXT.md is 8 KB or more");
  else {
    try { return readFileSync(path); } catch { problems.push(`${WORKING_FILE} is unreadable`); }
  }
  return null;
}

function destinationProblems(drive, folder) {
  const duet = join(drive, "Duet");
  if (kind(drive) !== "dir" || kind(duet) !== "dir") return [`${duet} is missing — is Google Drive running and signed in?`];
  const out = [];
  for (const [path, want, label] of [[join(duet, folder), "dir", `Duet/${folder}`], [join(duet, folder, "DUET-CONTEXT.md"), "file", `Duet/${folder}/DUET-CONTEXT.md`]]) {
    const found = kind(path);
    if (found === "symlink") out.push(`${label} is a symlink`);
    else if (found && found !== want) out.push(`${label} is not a regular ${want === "dir" ? "folder" : "file"}`);
  }
  return out;
}

/** One writer per Drive folder. The lock lives outside Drive so it never gets uploaded. */
function withLock(folder, fn) {
  const dir = join(configDir(), "locks");
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${folder.toLowerCase()}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; }
      } catch { continue; } // It vanished between the two calls, so try again.
      if (Date.now() > deadline) throw new Refused(["another push is running for this folder"]);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function push() {
  const config = loadConfig();
  const project = findProject(process.cwd());
  const entry = config.projects[project.id];
  if (!entry) throw new Refused(["this project is not set up. Run setup first."]);
  if (!FOLDER.test(entry.folder)) throw new Refused([`folder "${String(entry.folder).slice(0, 60)}" in ${configPath()} must be one plain name (letters, digits, spaces, _ or -)`]);

  const problems = project.isGit ? checkGitState(project) : [];
  const context = readContext(project, problems);
  const text = context?.toString("utf8");
  if (context) problems.push(...shapeProblems(text));

  const sources = [...findSources(project.root, problems), ...entry.scan.map((path) => ({ path, label: path, wholeLines: false }))];
  for (const source of sources) {
    const body = readSource(source, problems);
    if (body === null || !context) continue;
    for (const { name, value } of secretValues(body, source.label, source.wholeLines)) {
      if (text.includes(value)) problems.push(`DUET-CONTEXT.md contains the value of ${name}`);
    }
  }
  if (context) {
    for (const [pattern, what] of CREDENTIAL_PATTERNS) if (pattern.test(text)) problems.push(`DUET-CONTEXT.md contains ${what}`);
    problems.push(...linkProblems(text).map((what) => `DUET-CONTEXT.md has ${what}`));
  }
  problems.push(...destinationProblems(config.drive, entry.folder));
  if (problems.length) throw new Refused(problems);

  const label = `Duet/${entry.folder}/DUET-CONTEXT.md`;
  const folder = join(config.drive, "Duet", entry.folder);
  const out = join(folder, "DUET-CONTEXT.md");
  withLock(entry.folder, () => {
    try {
      mkdirSync(folder, { recursive: true });
      // In place, not a temp file and rename, so Drive keeps the same file and its id.
      writeFileSync(out, context);
      if (!readFileSync(out).equals(context)) throw new Error("it read back different");
    } catch (e) {
      process.stderr.write(`duet: write failed — ${label} may be missing or cut off (${e.code ?? e.message}). Fix that and push again.\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`duet: copied to ${label} (${context.length} bytes). Local copy verified; Google Drive upload not verified.\n`);
  });
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "--help" || command === "-h") { process.stdout.write(USAGE); return; }
  try {
    if (command === "setup") setup(argv);
    else if (command === "push" && argv.length === 0) push();
    else { process.stderr.write(USAGE); process.exitCode = 1; }
  } catch (e) {
    process.exitCode = 1;
    if (e instanceof Refused) process.stderr.write(`duet: refused — ${e.problems.length} problem(s):\n${e.problems.map((p) => `  - ${p}`).join("\n")}\n`);
    else if (e.code?.startsWith("ERR_PARSE_ARGS")) process.stderr.write(USAGE);
    else process.stderr.write(`duet: ${e.message}\n`);
  }
}

main();
