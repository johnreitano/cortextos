<!-- ===================================================================== -->
<!--  LOCAL TO THIS FORK — DO NOT MERGE UPSTREAM                           -->
<!--                                                                       -->
<!--  This file describes how johnreitano/cortextos deviates from           -->
<!--  grandamenium/cortextos. It is meaningless upstream and must never     -->
<!--  appear in a pull request against it.                                  -->
<!--                                                                       -->
<!--  It is tracked deliberately (so it survives a machine loss) and it     -->
<!--  therefore rides in our local patch stack — `git log upstream/main..   -->
<!--  main` lists it. That is safe ONLY because PR branches are cut from    -->
<!--  `upstream/main`, never from `main`. If you ever branch a PR off        -->
<!--  `main`, drop this file from it.                                        -->
<!-- ===================================================================== -->

# Local notes — this fork only

Tracked in this fork only — see the banner above. The repo's own `CLAUDE.md`
belongs to upstream; this file is for how *this* installation differs.

**Full details: `~/cortextos-data/OPERATIONS.md`** — read it before changing
anything about branches, `orgs/`, or the backup pipeline.

The three things most likely to bite you, inline so they are never missed:

1. **`main` is not a mirror of upstream.** It carries local patches we run in
   production — `git log upstream/main..main` lists them. `git pull` rebases
   them on top; publish with `git push --force-with-lease origin main`. Open PRs
   from branches cut off `upstream/main`, never off `main`.

2. **`dist/` is gitignored and the daemon runs it.** Checking out a commit
   without those patches and rebuilding silently strips the fixes from the
   running daemon, with no error — agents then start fresh sessions and appear
   amnesiac. If that happens, check `git log upstream/main..main` first.

3. **`orgs/` is a symlink to `~/cortextos-data/orgs`.** Do not relocate it.
   Claude Code keys agent session history by *resolved* path
   (`~/.claude/projects/<mangled>`, `/` and `.` both become `-`), so moving the
   tree orphans every agent's history — this crash-looped ten agents once.

Also: `.git/info/exclude` here is a real file, not the usual symlink into
`~/dotfiles`. Appending to the symlinked version in other repos edits every
repo created from that template.
