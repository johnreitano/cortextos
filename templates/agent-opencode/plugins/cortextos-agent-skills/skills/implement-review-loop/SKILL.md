---
name: implement-review-loop
description: "You have been asked to implement a feature or fix autonomously, end-to-end, without pausing for approval on every step. You will do an initial implementation, then run rounds of {review, fix} — up to 5 rounds — stopping as soon as a round comes back with no critical or important findings. This uses an isolated task worktree so most of the loop runs without a Telegram round-trip per tool call; only starting the task and merging the result require human approval."
triggers: ["implement and review", "review loop", "implement autonomously", "iterate until clean", "review-fix loop", "task worktree", "autonomous implementation", "implement then review", "self-review loop", "iterative implementation"]
---

# Implement / Review Loop

Ship one feature autonomously: implement it, then review-and-fix it against itself until it's clean or you've spent your iteration budget — all inside an isolated git worktree so the loop doesn't flood the user with a Telegram approval prompt per edit.

This skill is the execution half of a bigger pattern; if you don't already have a scoped spec (what to build, which files, what "done" means), get that first — from the user, from a task description, or by writing one yourself before starting the worktree.

---

## Why a task worktree

Normally, every `Edit`/`Write`/`Bash` call outside your own `.claude/` folder triggers a Telegram approval round-trip (see the `approvals` skill). That's the right default for one-off actions, but it makes a 5-round review loop across possibly dozens of file edits impractical — the user would get flooded.

A **task worktree** is a second, narrower trust zone: an isolated git branch + worktree where Edit/Write are auto-approved as long as they stay inside it, and Bash is auto-approved unconditionally for as long as the task is active (Bash commands can't be reliably confined to a directory, so this is a deliberate, wider trust grant for the loop's duration — see `src/hooks/index.ts` for the full reasoning). Ending the task closes that window immediately, so the actual merge is never covered by it — it goes through the normal gate, same as any other Bash call.

**Two human touchpoints total, not one per edit:**
1. Starting the task worktree (one normal Bash-permission tap — nothing special, same as running any other command)
2. Merging the result (a proper `create-approval` request, per the `approvals` skill's "merging to main = YES" rule)

---

## Step 1 — Start the task worktree

```bash
cortextos bus task-worktree start <task-name> --repo <path-to-target-repo>
```

- `<task-name>`: short, filesystem-safe identifier (letters/numbers/hyphens/underscores)
- `<path-to-target-repo>`: the repo you're implementing in (e.g. the leadio checkout) — NOT the cortextos framework repo, unless that's literally what you're changing
- Creates a dedicated branch (`task/<task-name>` by default) and a worktree at a fixed, predictable path — never inside the target repo's own tree
- Refuses if a task is already active for this agent — finish or abandon it first

Create a task (per the `tasks` skill) to track this work, and note the task-worktree path/branch in it.

---

## Step 2 — Initial implementation

Work inside the worktree path returned by `start`. Implement the spec fully — don't stop halfway expecting the review loop to finish it; the loop catches problems, it doesn't do the first draft.

Commit as you go (`git add` / `git commit` inside the worktree) so the diff at each review round is meaningful and the final merge approval shows real history, not one giant squash.

---

## Step 3 — Review + fix loop (max 5 rounds)

For each round:

1. **Review.** Spawn one or more reviewer subagents (via the `Agent`/Task tool) against the current diff (`git diff <default-branch>...<task-branch>` inside the worktree). Each reviewer returns findings tagged with a severity:
   - **critical** — wrong behavior, security issue, data loss risk, breaks a contract
   - **important** — real but non-catastrophic bug, missing test for a real code path, meaningful gap vs. the spec
   - **minor** — style, naming, small inefficiencies
   - **nit** — purely cosmetic

   For non-trivial changes, use more than one reviewer lens (correctness, security, test coverage) rather than a single generic pass — see the `code-review` patterns already used elsewhere in this system for how to structure that.

2. **Check the stop condition.** If there are no **critical** or **important** findings, stop the loop — you're done, go to Step 4. (Minor/nit findings don't block; fix them opportunistically if cheap, otherwise note them in the final summary.)

3. **Fix.** If there are critical/important findings, address them (yourself or via fix subagents), commit the fixes inside the worktree, and start the next round.

4. **Budget.** After 5 rounds, stop regardless of outcome. If critical/important findings remain at that point, do NOT silently merge — go to Step 4 in "needs human judgment" mode (see below).

Log each round as an event (`cortextos bus log-event`) so the round count and findings are visible on the dashboard, and write a memory entry per round.

---

## Step 4 — Finish and request merge approval

**Clean pass (no remaining critical/important findings):**
```bash
cortextos bus task-worktree finish
```
This deletes the state file (closing the trust window immediately, before anything else runs), re-validates the record, computes the diff stat and commit count, attempts to remove the worktree (a failure here is reported but does not block the approval request — you may need to clean it up manually), and automatically files a `create-approval` request (category `deployment`) summarizing the change. Follow the rest of the `approvals` skill's workflow from here — block your task on the approval ID, notify the user, wait for the inbox decision.

**Maxed out at 5 rounds with findings still open:**
Still run `cortextos bus task-worktree finish` (never leave a task active indefinitely), but make the approval context explicit about the residual risk — include the outstanding critical/important findings in the task's context/notes so the human is deciding with full information, not blindly approving. Consider recommending against merging as-is if the findings are serious.

**Giving up entirely:**
```bash
cortextos bus task-worktree finish --abandon
```
Discards the branch, no approval requested. Use this if the spec turned out to be wrong, blocked on something external, or not worth finishing.

---

## Step 5 — After approval

Once approved, perform the actual merge as a normal, individually-approved action in the **primary** repo checkout (not the now-removed worktree) — e.g. `git merge <task-branch>` or open a PR, per whatever the target repo's own workflow is. This happens outside the task-worktree trust window, so it goes through the standard Telegram permission tap like any other Bash command — that's intentional, it's the one moment that actually changes shared state.

If rejected, `git branch -D <task-branch>` to clean up and record why in the task.

---

## Hard Rules

1. **Never treat the primary repo checkout as a task worktree.** The trust boundary only ever covers the dedicated worktree path created by `start`.
2. **Never target `main`/`master` as the task branch.** `start` refuses this; don't work around it.
3. **One active task per agent at a time.** Finish or abandon before starting another.
4. **Always call `finish` (merge or abandon), never leave a task dangling.** An abandoned worktree with no `finish` call leaves the elevated-Bash-trust window open indefinitely.
5. **The merge itself is never auto-approved.** If you find yourself trying to merge or push from inside the active task window, stop — finish the task first.
