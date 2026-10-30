---
name: duet-sync
description: Use when the user runs /duet-sync, finishes a Claude Code session and wants Claude Duet caught up, or asks to sync a project to Duet through Google Drive.
---

# Duet sync

Duet reads one condensed file per project from Google Drive and nothing from the code. Rewrite that
file from the project as it stands now, then let the script check and copy it. The script is
`duet-sync.mjs` in this skill's base directory.

## First time in a project

Run `node <base>/duet-sync.mjs setup` from the project. If it reports more than one Drive folder,
ask the user which account to use and rerun with `--drive`. If the project keeps secrets somewhere
other than `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*` or `.private/`, add `--scan <path>` for each.

## Every sync

1. Read the project's plan, its CLAUDE.md or AGENTS.md, and what changed this session.
2. Write `.duet/DUET-CONTEXT.md` in full, from those sources. Don't edit the previous copy, so stale
   lines can't carry forward.
3. Run `node <base>/duet-sync.mjs push`.
4. Tell the user the result, in the script's words. If it says the upload is not verified, repeat
   that. Don't say Duet has the file.

## The file

Under 8 KB. These headings are required, and may carry more words after them:

```markdown
# <Project>: context for Duet

Condensed from <sources>, as of YYYY-MM-DD. If anything here disagrees with what I tell you, I win.

## The problem
## Who does what
## Rules
## What's built
## Open items
## What I need back from you
```

Write it for a reader who has never seen the code: plain sentences, dates on open items, and what
the user wants Duet to do with this project.

Keep it to the work itself. Describe client data, customer records, health or money details, other
people's personal information and anything confidential in general terms, or leave it out. The
script catches common secret formats. It can't recognize private information.

## When push fails

| Exit | Meaning | Do this |
|---|---|---|
| 1 | Refused. Nothing was written. | Fix each listed problem in the file and push again. If a problem names a secret's value, remove it from the file. Don't copy the secret into chat. |
| 2 | The write failed. The Drive copy may be cut off. | Tell the user, fix the cause it names, and push again. |

Never work around a refusal by editing `.env`, renaming a secret file, adding `--replace`, or
copying the file into Drive by hand. If a refusal looks wrong, tell the user which line it names.
