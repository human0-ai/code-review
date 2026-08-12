# AI Development Guidelines

This file tells AI agents how to work in this repository. Keep it concise — add
only essential guidelines, not examples or edge cases. Agents read it on every
run, so it's the cheapest place to teach them your conventions.

> `CLAUDE.md` is a symlink to this file, so tools that look for either name find
> the same guidance.

## Structure

- `run.mjs` — the action entrypoint: reads the PR diff, runs the review, posts the verdict.
- `scope.mjs` / `scope.test.mjs` — diff-scoping helpers and their tests.
- `action.yml` — the Action's inputs and wiring.
- `prompt/` — `header.md` and `footer.md` wrapped around your standards prompt.
- `docs/` — cross-cutting documentation, including `ai-review.md`.
- `/.plans/` — short-lived plan files for active work (date-prefixed, deleted when done).

## Core Principles

- **Minimalism** — only write what's necessary; less code is less maintenance.
- **Code Quality** — clarity over cleverness, meaningful names.
- **No Duplicate Code** — extract shared logic; refactor if it repeats.
- **Small Functions** — single purpose, easy to read.
- **Testing** — focus on critical paths and edge cases, not coverage for its own sake.
- **Documentation** — document "why", not "what"; keep docs near the code.
- **Plain Language** — when talking to people, drop the jargon. Short sentences,
  friendly tone. Tell them **what** you did and **why** it matters — not **how**.
  The code already shows the how.

## Ownership

Own the task end-to-end. Owning something means you're responsible for the
outcome being right — not just for doing what you were told.

- **Default to action.** If the next step is obvious, take it.
- **Pick a path.** When two options are close, choose one and note why in the PR.
- **Recover yourself.** Failing tests, lint errors, broken CI — fix them. Don't
  escalate things you can resolve.
- **Only ask when stuck for real.** Genuine ambiguity, scope changes, or
  destructive actions warrant a question. Routine work doesn't.
- **Push back when you should.** Say so when a request is wrong, risky, or there's
  a clearly better path. Agreeing to be agreeable isn't ownership.
- **Close the loop.** Keep going until the code is in, CI is green, review threads
  converge, and the PR is ready to merge — then report back.

## Workflow

Your job is to land a PR. Build the change, open a draft PR early, keep CI green,
and the moment the user says "go" flip it to ready with auto-merge on and drive
it through review.

1. **Read context first** — the root `README.md`, this file, related `/docs/`
   and `/.plans/` files — so changes are grounded in what already exists.
2. **Build with the user — don't gate on sign-off.** Confirm you understand the
   request, then start. Surface trade-offs as they come up.
3. **Open the draft PR yourself, early.** As soon as you have a first meaningful
   commit, push and open a **draft** PR — automatically, without being asked.
4. **Keep CI green.** Run `npm run lint && npm test` before pushing, and fix any
   CI failures yourself.
5. **Make it easy to say "go".** When the work is done, send one clear message:
   here's what changed, here's what to check, it's ready for your call.
6. **On "go", ship it — never merge yourself.** Delete any `/.plans/` files this
   PR fully implements, update the PR title/description and any touched docs,
   flip the PR to ready for review, and enable auto-merge so the AI reviewer's
   approval lands it.
7. **Drive to merge autonomously.** Address every reviewer thread yourself;
   `REQUEST_CHANGES` blocks auto-merge. Only re-engage the user on a real scope
   change, destructive action, or genuine ambiguity.

## PR Descriptions

Write for a non-technical reader. Describe **what** changed and **why**, not
**how** — the code shows the how. Keep it short.

## AI Reviewer

This repo reviews itself: the [human0-ai/code-review](https://github.com/human0-ai/code-review)
action runs on every ready PR (wired up in `.github/workflows/ai-review.yml`) and
submits an `APPROVE` or `REQUEST_CHANGES` verdict. **`APPROVE` triggers
auto-merge** once CI is green, so the reviewer's bar is "ship as-is" — anything
still open is `REQUEST_CHANGES`, and that gate blocks the merge until resolved.

**Aim for consensus on every open thread** — fix the issue, or reply with
reasoning. Push back when you disagree; the reviewer isn't infallible. But don't
merge through a stalemate: if the reviewer holds firm on a point you can't
resolve in code, fix it in this PR when you reasonably can — otherwise ask the
user whether it deserves a follow-up, and only write one if they say yes.

Re-trigger a review after replying with an empty commit:
`git commit --allow-empty`. Keep iterating until both sides converge.

The reviewer's prompt lives at `docs/ai-review.md` — edit that file to change how
the reviewer behaves.

## Releases

Releases are driven by `package.json`: bump the `version` in a PR, and merging it
tags and releases that version and re-points the floating `@v1` tag.

**If your PR changes what `@v1` users run — `action.yml`, `run.mjs`, `scope.mjs`,
or `prompt/` — bump the `version` in the same PR.** Skip the bump and the change
merges to `main` but never ships: `@v1` stays pinned to the last released version.
Docs-, test-, and CI-only changes don't need a bump.

## Plans & Docs

`/.plans/` and `/docs/` are **living documents** — update them in the same PR as
the related code, never leave them stale.

- `/.plans/` — date-prefixed (e.g. `2026-01-27-feature-name.md`), one feature per
  plan. **Delete the plan in the same PR that finishes it.** A landed-but-not-removed
  plan is stale on arrival, and the AI reviewer will block on it.
  **Never file a follow-up plan on your own.** Finish the work in this PR if it's
  in reach; if it isn't, ask the user — they decide whether it's worth a plan, a
  note in the PR, or nothing at all. Plans nobody picks up are clutter, not progress.
- `/docs/` — cross-cutting docs; fix or remove them when code makes them wrong.
