import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Scratch HOME, scratch project and scratch Drive folder only. Never the real Drive.

const SCRIPT = fileURLToPath(new URL("../duet-sync.mjs", import.meta.url));

const CONTEXT = `# Harbor Bakery: context for Duet

Condensed from the project plan and CLAUDE.md, as of 2026-10-30. If anything here disagrees with
what I tell you, I win.

## The problem

The order form loses weekend orders.

## Who does what

I run the bakery. Claude Code maintains the site.

## Rules

Nothing deploys without my say-so.

## What's built (2026-10-29)

The order form and its email receipt. Docs: https://example.com/orders?page=2&ref=duet

## Open items

- Holiday menu, due 2026-11-20.

## What I need back from you

A weekly list of what to decide next.
`;

const scratch = (name) => mkdtempSync(join(tmpdir(), `duet-${name}-`));
const fake = (tag) => `${tag}-${Math.random().toString(36).slice(2)}-fixture`;

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
}

function run(cwd, env, ...args) {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd, env }, (err, stdout, stderr) => {
      done({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/** A project, a home and a Drive folder. `setup: false` stops before `setup`. */
async function make({ name = "harbor", context = CONTEXT, useGit = true, setup = true } = {}) {
  const dir = join(scratch("project"), name);
  mkdirSync(dir);
  if (useGit) {
    git(dir, "init", "-q");
    git(dir, "commit", "-q", "--allow-empty", "-m", "start");
  }
  const home = scratch("home");
  const drive = scratch("drive");
  const env = { ...process.env, HOME: home };
  const s = { dir, home, drive, env, folder: name, push: () => run(dir, env, "push"), setup: (...a) => run(dir, env, "setup", ...a) };
  if (setup) {
    const r = await s.setup("--drive", drive);
    assert.equal(r.code, 0, r.stderr);
    if (context !== null) writeFileSync(join(dir, ".duet/DUET-CONTEXT.md"), context);
  }
  return s;
}

/** Every file under the Drive folder with its bytes: "byte-identical" means this is unchanged. */
function snap(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) out[p.slice(root.length)] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) { out[p.slice(root.length) + "/"] = "dir"; walk(p); }
      else out[p.slice(root.length)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

async function refused(s, re) {
  const before = snap(s.drive);
  const r = await s.push();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^duet: refused — \d+ problem\(s\):\n/);
  if (re) assert.match(r.stderr, re);
  assert.deepEqual(snap(s.drive), before, "Drive untouched");
  return r;
}

const out = (s) => join(s.drive, "Duet", s.folder, "DUET-CONTEXT.md");
const withContext = async (text) => make({ context: text });

// --- push -------------------------------------------------------------------------------

test("push copies the file, says the upload is unverified, and a rerun overwrites in place", async () => {
  const s = await make();
  let r = await s.push();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `duet: copied to Duet/harbor/DUET-CONTEXT.md (${Buffer.byteLength(CONTEXT)} bytes). Local copy verified; Google Drive upload not verified.\n`);
  assert.equal(readFileSync(out(s), "utf8"), CONTEXT);
  const ino = statSync(out(s)).ino;
  writeFileSync(join(s.dir, ".duet/DUET-CONTEXT.md"), CONTEXT.replace("weekly list", "daily list"));
  r = await s.push();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(statSync(out(s)).ino, ino, "same file, overwritten in place");
  assert.doesNotMatch(readFileSync(out(s), "utf8"), /weekly list/, "replaced, not appended");
});

test("push works outside git, and from a subfolder of a git project", async () => {
  const plain = await make({ useGit: false });
  assert.equal((await plain.push()).code, 0);
  const s = await make();
  mkdirSync(join(s.dir, "src"));
  const r = await run(join(s.dir, "src"), s.env, "push");
  assert.equal(r.code, 0, r.stderr);
});

test("push without setup is refused and writes nothing", async () => {
  const s = await make({ setup: false });
  const r = await s.push();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not set up/);
});

test("a git worktree shares its main checkout's registration", async () => {
  const s = await make();
  const wt = join(scratch("wt"), "branch");
  git(s.dir, "worktree", "add", "-q", wt, "-b", "side");
  mkdirSync(join(wt, ".duet"));
  writeFileSync(join(wt, ".duet/DUET-CONTEXT.md"), CONTEXT.replace("weekly list", "worktree list"));
  const r = await run(wt, s.env, "push");
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(out(s), "utf8"), /worktree list/);
});

test("parallel pushes all finish and leave one whole file", async () => {
  const s = await make();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => s.push()));
  for (const r of rs) assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(out(s), "utf8"), CONTEXT);
  const locks = join(s.home, ".config/duet-bridge/locks");
  assert.deepEqual(readdirSync(locks), [], "no lock left behind");
});

test("a stale lock is cleared; a live one refuses without writing", async () => {
  const s = await make();
  const lock = join(s.home, ".config/duet-bridge/locks/harbor.lock");
  mkdirSync(join(lock, ".."), { recursive: true });
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 120000);
  utimesSync(lock, old, old);
  assert.equal((await s.push()).code, 0);

  const t = await make();
  const live = join(t.home, ".config/duet-bridge/locks/harbor.lock");
  mkdirSync(join(live, ".."), { recursive: true });
  writeFileSync(live, "");
  await refused(t, /another push is running/);
});

test("a failed write exits 2 and says the Drive copy may be cut off", async () => {
  const s = await make();
  assert.equal((await s.push()).code, 0);
  chmodSync(out(s), 0o444);
  try {
    const r = await s.push();
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /^duet: write failed — Duet\/harbor\/DUET-CONTEXT\.md may be missing or cut off/);
  } finally { chmodSync(out(s), 0o644); }
});

// --- setup ------------------------------------------------------------------------------

test("setup excludes .duet through info/exclude, keeps what was there, and leaves .gitignore alone", async () => {
  const s = await make({ setup: false });
  const exclude = join(s.dir, ".git/info/exclude");
  writeFileSync(exclude, "mine.log");
  const r = await s.setup("--drive", s.drive);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(exclude, "utf8"), "mine.log\n/.duet/\n");
  assert.ok(!existsSync(join(s.dir, ".gitignore")));
  await s.setup();
  assert.equal(readFileSync(exclude, "utf8"), "mine.log\n/.duet/\n", "not added twice");
  assert.equal(git(s.dir, "status", "--short", "--untracked-files=all"), "");
});

test("setup refuses tracked .duet files and a repo that re-includes them", async () => {
  const s = await make({ setup: false });
  mkdirSync(join(s.dir, ".duet"));
  writeFileSync(join(s.dir, ".duet/DUET-CONTEXT.md"), CONTEXT);
  git(s.dir, "add", ".duet");
  git(s.dir, "commit", "-q", "-m", "oops");
  let r = await s.setup("--drive", s.drive);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\.duet is tracked by git/);
  assert.equal(git(s.dir, "ls-files", ".duet"), ".duet/DUET-CONTEXT.md", "never untracked for you");

  const t = await make({ setup: false });
  writeFileSync(join(t.dir, ".gitignore"), "!/.duet/\n!/.duet/**\n");
  r = await t.setup("--drive", t.drive);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\.duet is not git-ignored/);
});

test("push refuses a context file that became tracked after setup", async () => {
  const s = await make();
  git(s.dir, "add", "-f", ".duet/DUET-CONTEXT.md");
  git(s.dir, "commit", "-q", "-m", "oops");
  await refused(s, /\.duet is tracked by git/);
});

test("setup finds one Drive folder, and refuses none or several", async () => {
  const s = await make({ setup: false });
  let r = await s.setup();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no Google Drive folder found/);

  const one = join(s.home, "Library/CloudStorage/GoogleDrive-a@example.com/My Drive");
  mkdirSync(one, { recursive: true });
  r = await s.setup();
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(one, "Duet")));

  const t = await make({ setup: false });
  for (const a of ["a", "b"]) mkdirSync(join(t.home, `Library/CloudStorage/GoogleDrive-${a}@example.com/My Drive`), { recursive: true });
  r = await t.setup();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /more than one Google Drive folder/);
  assert.match(r.stderr, /--drive/);
  assert.match(r.stderr, /GoogleDrive-a@example\.com/);
});

test("mirror mode's ~/My Drive is found, and a symlinked --drive resolves to the real folder", async () => {
  const s = await make({ setup: false });
  mkdirSync(join(s.home, "My Drive"));
  assert.equal((await s.setup()).code, 0);
  assert.ok(existsSync(join(s.home, "My Drive/Duet")));

  const t = await make({ setup: false });
  const link = join(t.home, "shortcut");
  symlinkSync(t.drive, link);
  const r = await t.setup("--drive", link);
  assert.equal(r.code, 0, r.stderr);
  writeFileSync(join(t.dir, ".duet/DUET-CONTEXT.md"), CONTEXT);
  assert.equal((await t.push()).code, 0);
  assert.ok(existsSync(out(t)));
});

test("setup refuses a Drive folder inside the project", async () => {
  for (const drive of [".", "docs/drive"]) {
    const s = await make({ setup: false });
    mkdirSync(join(s.dir, "docs/drive"), { recursive: true });
    const r = await s.setup("--drive", drive);
    assert.equal(r.code, 1, drive);
    assert.match(r.stderr, /is inside this project/);
    assert.ok(!existsSync(join(s.dir, "Duet")));
    assert.ok(!existsSync(join(s.dir, "docs/drive/Duet")));
  }
});

test("push refuses a folder name that was edited into the config", async () => {
  const s = await make();
  const cfg = join(s.home, ".config/duet-bridge/config.json");
  const config = JSON.parse(readFileSync(cfg, "utf8"));
  for (const project of Object.values(config.projects)) project.folder = "../escaped";
  writeFileSync(cfg, JSON.stringify(config));
  await refused(s, /must be one plain name/);
  assert.ok(!existsSync(join(s.drive, "escaped")));
});

test("setup refuses a missing --drive and a symlinked Duet folder", async () => {
  const s = await make({ setup: false });
  let r = await s.setup("--drive", join(s.drive, "nope"));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nope is missing/);

  symlinkSync(scratch("elsewhere"), join(s.drive, "Duet"));
  r = await s.setup("--drive", s.drive);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Duet is a symlink/);
});

test("folder names are one plain name, and a default is made safe", async () => {
  for (const bad of ["../x", "a/b", ".hidden", "x".repeat(42)]) {
    const s = await make({ setup: false });
    const r = await s.setup("--drive", s.drive, "--folder", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /must be one plain name/);
    assert.deepEqual(readdirSync(s.drive), [], "nothing created");
  }
  const s = await make({ setup: false, name: "my.app (v2)" });
  assert.equal((await s.setup("--drive", s.drive)).code, 0);
  s.folder = "my-app-v2";
  writeFileSync(join(s.dir, ".duet/DUET-CONTEXT.md"), CONTEXT);
  assert.equal((await s.push()).code, 0);
  assert.ok(existsSync(out(s)));
});

test("two projects can't share a folder, in any letter case", async () => {
  const s = await make();
  const other = join(scratch("project"), "Harbor");
  mkdirSync(other);
  const r = await run(other, s.env, "setup", "--drive", s.drive);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already used by/);
  assert.equal((await run(other, s.env, "setup", "--drive", s.drive, "--folder", "Harbor-2")).code, 0);
});

test("a folder that already holds a context file needs --replace", async () => {
  const s = await make({ setup: false });
  mkdirSync(join(s.drive, "Duet/harbor"), { recursive: true });
  writeFileSync(join(s.drive, "Duet/harbor/DUET-CONTEXT.md"), "from another machine\n");
  let r = await s.setup("--drive", s.drive);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already holds a context file/);
  r = await s.setup("--drive", s.drive, "--replace");
  assert.equal(r.code, 0, r.stderr);
  r = await s.setup();
  assert.equal(r.code, 0, "rerunning setup on its own project needs no --replace: " + r.stderr);
});

test("setup refuses a broken config instead of overwriting it", async () => {
  const s = await make();
  const cfg = join(s.home, ".config/duet-bridge/config.json");
  writeFileSync(cfg, "{ not json");
  const r = await s.setup();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /config\.json is not valid/);
  assert.equal(readFileSync(cfg, "utf8"), "{ not json");
});

// --- shape ------------------------------------------------------------------------------

test("push refuses a wrong shape, an oversized file or a missing file", async () => {
  await refused(await withContext(CONTEXT.replace("## Open items", "## Open")), /missing heading "## Open items"/);
  await refused(await withContext(CONTEXT.replace("## Rules", "## RulesAndMore")), /missing heading "## Rules"/);
  await refused(await withContext(CONTEXT.replace("as of 2026-10-30", "recently")), /no "as of YYYY-MM-DD" line/);
  await refused(await withContext(CONTEXT + "x".repeat(8192)), /DUET-CONTEXT\.md is 8 KB or more/);
  await refused(await make({ context: null }), /\.duet\/DUET-CONTEXT\.md is missing/);
});

test("headings may carry more words", async () => {
  const s = await withContext(CONTEXT.replace("## Rules", "## Rules for each change"));
  assert.equal((await s.push()).code, 0);
});

test("push refuses a symlinked context file", async () => {
  const s = await make({ context: null });
  const real = join(scratch("real"), "x.md");
  writeFileSync(real, CONTEXT);
  symlinkSync(real, join(s.dir, ".duet/DUET-CONTEXT.md"));
  await refused(s, /DUET-CONTEXT\.md is a symlink/);
});

// --- the secret gate --------------------------------------------------------------------

test("a secret value from any default source is refused, named and never echoed", async () => {
  const cases = [
    [".env", (v) => `API_TOKEN=${v}\n`, /API_TOKEN from \.env/],
    [".env", (v) => `stripe_key=${v}\n`, /stripe_key from \.env/],
    [".env", (v) => `export DB_PASS="${v}"\n`, /DB_PASS from \.env/],
    [".env", (v) => `TOKEN=${v} # rotated monthly\n`, /TOKEN from \.env/],
    [".env", (v) => `# OLD_TOKEN=${v}\n`, /OLD_TOKEN from \.env/],
    [".env.local", (v) => `WEB_SECRET=${v}\n`, /WEB_SECRET from \.env\.local/],
    [".env.production", (v) => `WEB_SECRET=${v}\n`, /WEB_SECRET from \.env\.production/],
    [".dev.vars", (v) => `WORKER_SECRET=${v}\n`, /WORKER_SECRET from \.dev\.vars/],
    [".dev.vars.staging", (v) => `WORKER_SECRET=${v}\n`, /WORKER_SECRET from \.dev\.vars\.staging/],
    ["apps/web/.env", (v) => `NESTED_TOKEN=${v}\n`, /NESTED_TOKEN from apps\/web\/\.env/],
    [".private/notes/admin.txt", (v) => `pin\n${v}\n`, /line 2 of \.private\/notes\/admin\.txt/],
    [".private/keys.yml", (v) => `api_key: ${v}\n`, /api_key from \.private\/keys\.yml/],
    [".private/keys.json", (v) => `{\n  "client_secret": "${v}",\n}\n`, /client_secret from \.private\/keys\.json/],
  ];
  for (const [file, body, re] of cases) {
    const v = fake("value");
    const s = await withContext(CONTEXT.replace("A weekly list", `A weekly list ${v}`));
    mkdirSync(join(s.dir, file, ".."), { recursive: true });
    writeFileSync(join(s.dir, file), body(v));
    const r = await refused(s, re);
    assert.ok(!r.stderr.includes(v) && !r.stdout.includes(v), "never echoed");
  }
});

test("a short credential counts from 8 characters; a short ordinary value doesn't", async () => {
  await (async () => {
    const s = await withContext(CONTEXT.replace("A weekly list", "A weekly hunter22 list"));
    writeFileSync(join(s.dir, ".env"), "DB_PASSWORD=hunter22\n");
    await refused(s, /DB_PASSWORD from \.env/);
  })();
  const s = await withContext(CONTEXT.replace("A weekly list", "A weekly production list"));
  writeFileSync(join(s.dir, ".env"), "NODE_ENV=production\n");
  assert.equal((await s.push()).code, 0);
});

test("a password inside a connection string is a value of its own", async () => {
  const j = (...p) => p.join(""); // Assembled at runtime so secret scanners don't flag this file.
  const pw = "hunter22x";
  const s = await withContext(CONTEXT.replace("A weekly list", `The password is ${pw}. A weekly list`));
  writeFileSync(join(s.dir, ".env"), `DATABASE_URL=${j("postgres", "://app:", pw, "@db.example.com/orders")}\n`);
  const r = await refused(s, /DATABASE_URL's password from \.env/);
  assert.ok(!r.stderr.includes(pw), "never echoed");
});

test("a local development connection string doesn't block the word postgres", async () => {
  const j = (...p) => p.join("");
  const s = await withContext(CONTEXT + "\nThe app runs on postgres.\n");
  writeFileSync(join(s.dir, ".env"), `DATABASE_URL=${j("postgres", "://postgres:postgres@localhost:5432/app")}\n`);
  const r = await s.push();
  assert.equal(r.code, 0, r.stderr);
});

test("values that look public don't block a summary", async () => {
  const s = await withContext(CONTEXT + "\nHarbor Bakery Online runs at https://shop.example.com on http://localhost:3000.\n");
  writeFileSync(join(s.dir, ".env"), "APP_NAME=Harbor Bakery Online\nSITE_URL=https://shop.example.com\nDEV_URL=http://localhost:3000\nDEBUG=true\n");
  const r = await s.push();
  assert.equal(r.code, 0, r.stderr);
});

test("an ordinary-looking key with a long opaque value still counts", async () => {
  const v = "Zx81kQ0pLm2vTt7c";
  const s = await withContext(CONTEXT.replace("A weekly list", `A weekly ${v} list`));
  writeFileSync(join(s.dir, ".env"), `PROVIDER_REF=${v}\n`);
  await refused(s, /PROVIDER_REF from \.env/);
});

test("--scan adds a source, and a source that vanished fails closed", async () => {
  const v = fake("extra");
  const s = await withContext(CONTEXT.replace("A weekly list", `A weekly list ${v}`));
  const extra = join(scratch("secrets"), "api.txt");
  writeFileSync(extra, `SERVICE_TOKEN=${v}\n`);
  assert.equal((await s.setup("--scan", extra)).code, 0);
  await refused(s, /SERVICE_TOKEN from .*api\.txt/);
  execFileSync("rm", [extra]);
  await refused(s, /api\.txt is missing/);
});

test("--scan on a path that doesn't exist is refused at setup", async () => {
  const s = await make();
  const r = await s.setup("--scan", "nope.txt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nope\.txt is missing/);
});

test("dependency and build folders aren't scanned; a .env virtualenv folder isn't either", async () => {
  const v = fake("vendored");
  const s = await withContext(CONTEXT.replace("A weekly list", `A weekly list ${v}`));
  for (const d of ["node_modules/pkg", "dist", ".env/lib"]) {
    mkdirSync(join(s.dir, d), { recursive: true });
    writeFileSync(join(s.dir, d, ".env"), `SOME_TOKEN=${v}\n`);
  }
  assert.equal((await s.push()).code, 0);
});

test("the gate fails closed on what it can't check", async () => {
  let s = await make();
  mkdirSync(join(s.dir, ".private"));
  writeFileSync(join(s.dir, ".private/locked"), "x\n");
  chmodSync(join(s.dir, ".private/locked"), 0o000);
  await refused(s, /\.private\/locked is unreadable/);
  chmodSync(join(s.dir, ".private/locked"), 0o600);

  s = await make();
  writeFileSync(join(s.dir, ".env"), "x".repeat(1024 * 1024));
  await refused(s, /\.env is 1 MB or more/);

  s = await make();
  symlinkSync("/nonexistent/dangling", join(s.dir, ".env"));
  await refused(s, /\.env is a broken symlink/);

  s = await make();
  symlinkSync(scratch("realprivate"), join(s.dir, ".private"));
  await refused(s, /\.private is a symlinked folder/);
});

test("a symlinked .env is followed and scanned", async () => {
  const v = fake("linked");
  const s = await withContext(CONTEXT.replace("A weekly list", `A weekly list ${v}`));
  const real = join(scratch("real"), "shared.env");
  writeFileSync(real, `SHARED_TOKEN=${v}\n`);
  symlinkSync(real, join(s.dir, ".env"));
  await refused(s, /SHARED_TOKEN from \.env/);
});

test("credential shapes are refused", async () => {
  // Assembled at runtime so secret scanners don't flag this file.
  const j = (...p) => p.join("");
  const a = (n) => "a".repeat(n), A = (n) => "A".repeat(n);
  for (const [value, re] of [
    [j("s", "k-", a(20)), /an API key/],
    [j("s", "k-ant-", a(20)), /an API key/],
    [j("gh", "p_", a(36)), /a GitHub token/],
    [j("github", "_pat_", a(40)), /a GitHub token/],
    [j("gl", "pat-", a(20)), /a GitLab token/],
    [j("AK", "IA", A(16)), /an AWS access key/],
    [j("AI", "za", a(35)), /a Google API key/],
    [j("xo", "xb-", "123456789012-", a(20)), /a Slack token/],
    [j("hooks.slack", ".com/services/T000/B000/", a(20)), /a webhook URL/],
    [j("discord", ".com/api/webhooks/123456/", a(20)), /a webhook URL/],
    [j("s", "k_live_", a(24)), /a Stripe key/],
    [j("whs", "ec_", a(24)), /a Stripe key/],
    [j("np", "m_", a(36)), /an npm token/],
    [j("S", "G.", a(22), ".", a(43)), /a SendGrid key/],
    [j("nf", "p_", a(24)), /a Netlify token/],
    [j("123456789", ":", a(35)), /a Telegram bot token/],
    [j("-----BEGIN ", "RSA PRIVATE KEY-----"), /a private key/],
    [j("ey", "J", a(16), ".ey", "J", a(16), ".", a(16)), /a JSON web token/],
    [j("Bear", "er ", a(24)), /a bearer token/],
    [j("postgres", "://admin:pw123@db.example.com/app"), /a connection string with a password/],
    [j("mongodb", "+srv://admin:pw123@db.example.com/app"), /a connection string with a password/],
  ]) {
    const r = await refused(await withContext(CONTEXT.replace("A weekly list", `A weekly list ${value}`)), re);
    assert.ok(!r.stderr.includes(value), "never echoed");
  }
});

test("token links are refused in the query or the fragment, never printed", async () => {
  for (const [url, re] of [
    ["https://x.example/a?token=abc", /a link with a token= parameter/],
    ["https://x.example/a?b=1&Sig=abc", /a link with a sig= parameter/],
    ["https://x.example/a?ACCESS_TOKEN=abc", /a link with a access_token= parameter/],
    ["https://x.example/a?api_key=abc", /a link with a api_key= parameter/],
    ["https://x.example/a?client_secret=abc", /a link with a client_secret= parameter/],
    ["https://x.example/a?X-Api-Key=abc", /a link with a x-api-key= parameter/],
    ["https://x.example/cb#access_token=abc&state=1", /a link with a access_token= parameter/],
    ["https://user:pw@x.example/a", /a link with a user:password/],
    ["<https://x.example/a(b)?token=abc>", /a link with a token= parameter/],
    ["[docs](https://x.example/a?key=abc)", /a link with a key= parameter/],
    ["https://x.example:99999999/a?token=abc", /a link that cannot be parsed/],
  ]) {
    const r = await refused(await withContext(CONTEXT.replace("A weekly list", `See ${url}`)), re);
    assert.ok(!r.stderr.includes("x.example"), "the link itself is not printed");
  }
});

test("ordinary links and query keys are fine", async () => {
  const s = await withContext(CONTEXT.replace("A weekly list", "See https://x.example/a?ref=duet&page=2&keyword=cake&monkey=1#section"));
  const r = await s.push();
  assert.equal(r.code, 0, r.stderr);
});

// --- destination ------------------------------------------------------------------------

test("push refuses a symlinked destination and a missing Drive folder", async () => {
  let s = await make();
  const elsewhere = scratch("elsewhere");
  symlinkSync(elsewhere, join(s.drive, "Duet/harbor"));
  await refused(s, /Duet\/harbor is a symlink/);
  assert.deepEqual(readdirSync(elsewhere), []);

  s = await make();
  mkdirSync(join(s.drive, "Duet/harbor"));
  const real = join(scratch("elsewhere"), "file.md");
  writeFileSync(real, "not yours\n");
  symlinkSync(real, join(s.drive, "Duet/harbor/DUET-CONTEXT.md"));
  await refused(s, /DUET-CONTEXT\.md is a symlink/);
  assert.equal(readFileSync(real, "utf8"), "not yours\n");

  s = await make();
  const parked = `${s.drive}-parked`;
  execFileSync("mv", [s.drive, parked]);
  const r = await s.push();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is missing — is Google Drive running and signed in\?/);
  assert.ok(!existsSync(s.drive), "the missing Drive is not recreated");
});

// --- the CLI ----------------------------------------------------------------------------

test("no command or an unknown flag prints usage", async () => {
  const s = await make({ setup: false });
  for (const args of [[], ["nope"], ["setup", "--wat"]]) {
    const r = await run(s.dir, s.env, ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /usage: /);
  }
  const r = await run(s.dir, s.env, "--help");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: /);
});

test("the skill names the script", () => {
  assert.equal(basename(SCRIPT), "duet-sync.mjs");
  const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^---\nname: duet-sync\n/);
  assert.match(skill, /duet-sync\.mjs push/);
});

test("the example in the repo passes the gate", async () => {
  const example = readFileSync(new URL("../example/DUET-CONTEXT.md", import.meta.url), "utf8");
  const s = await withContext(example);
  const r = await s.push();
  assert.equal(r.code, 0, r.stderr);
});
