# Duet Bridge with Google Drive

Claude Code knows what happened in your project. Claude Duet doesn't. This skill keeps a short,
checked summary of each project in a Google Drive folder that Duet can read, so Duet can plan with
you from what's actually been built.

Unofficial. Not made by, affiliated with or endorsed by Anthropic.

```
Claude Code session ──▶ .duet/DUET-CONTEXT.md ──▶ safety check ──▶ My Drive/Duet/<project>/ ──▶ Duet
```

It's one way: Duet reads, and nothing comes back into your project. No server, no API keys, and no
dependencies. Google Drive for desktop does the uploading.

## What you need

- A Mac with [Google Drive for desktop](https://www.google.com/drive/download/), signed in
- Claude Code
- Node 18.3 or newer
- Access to Claude Duet, with Google Drive connected to it

## Install

```bash
git clone https://github.com/wyattfulkerson11-boop/Duet-Bridge-with-GD ~/.claude/skills/duet-sync
```

Then start a new Claude Code session so it picks up the skill.

## Use

At the end of a Claude Code session, in your project:

```
/duet-sync
```

The first run sets the project up. After that, Claude rewrites the summary, the script checks it,
and it's copied to `My Drive/Duet/<project>/DUET-CONTEXT.md`. Give Google Drive a minute or so to
upload it, then ask Duet:

> Read Duet/<project>/DUET-CONTEXT.md in my Google Drive.

[`example/DUET-CONTEXT.md`](example/DUET-CONTEXT.md) shows what a summary looks like.

To sync after every session without asking, add this to your project's `CLAUDE.md`:

```markdown
Before you finish a session that changed something, run /duet-sync.
```

## What the safety check does

Before anything reaches Drive, `push` refuses a summary if it finds:

- a value from a `.env`, `.env.*`, `.dev.vars` or `.dev.vars.*` file in the project, from anything in
  `.private/`, or from a path you add with `--scan`. That includes the password inside a connection
  string. Dependency and build folders like `node_modules`, `vendor` and `dist` are skipped.
- a common credential format: API keys, GitHub, AWS, Google, Slack, Stripe and similar tokens,
  private keys, JSON web tokens, connection strings with passwords, webhook URLs
- a link carrying a token, or a `user:password` link
- a missing required heading, no "as of" date, or a size of 8 KB or more

It names what it found without printing the value. If it can't read a source, it refuses instead of
skipping it. Nothing is written until every check passes.

**This is a best-effort filter, not a guarantee.** It only knows the formats listed above and the
files it can find. It ignores values under 8 characters, so a short password gets through, and
ordinary-looking values under 12. It can't recognize a customer's name or a confidential plan. Read
your first few summaries, and don't use this on a project whose details shouldn't be in your Google
Drive.

Text in your project can end up in the summary, and Duet reads the summary as context. Only sync
projects you trust.

## Good to know

- **Upload isn't confirmed.** `push` proves the file is in your local Drive folder. Google Drive
  uploads it afterward, usually within a minute or so, and the script says so.
- **Your repo stays untouched.** The working file lives in `.duet/`, which `setup` adds to git's
  local exclude file. It never edits `.gitignore`, and it refuses if `.duet` is tracked.
- **Stream or mirror mode both work.** `setup` looks in `~/Library/CloudStorage/GoogleDrive-*/My Drive`
  and `~/My Drive`. If you have several accounts or a custom folder, pass `--drive`:

  ```bash
  node ~/.claude/skills/duet-sync/duet-sync.mjs setup --drive "/path/to/My Drive"
  ```

- **Each project gets its own Drive folder.** The name comes from the project folder. Two projects
  can't share one. Use `--folder` to pick a name.
- **Settings** live in `~/.config/duet-bridge/config.json`. Delete a project's entry to stop syncing
  it. Its Drive folder stays until you delete it.

## Commands

```
duet-sync.mjs setup [--drive PATH] [--folder NAME] [--scan PATH]... [--replace]
duet-sync.mjs push
```

`push` exits 0 when copied, 1 when refused (nothing written), and 2 when the write failed (the Drive
copy may be cut off, so fix the cause and push again).

## Tests

```bash
node --test
```

Tests run in temporary folders with fake secrets and never touch your real Drive.

## License

MIT
