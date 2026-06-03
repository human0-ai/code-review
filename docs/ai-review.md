# Review standards

> This file is the part of the reviewer **this repo owns** — the bar and what to
> check, tailored to this project. The fixed machinery (the context you're given,
> the scope rule, the output format) ships with the action itself. Keep this
> short and specific; a repo's standards should fit the repo.

This repository **is** the AI reviewer — the GitHub Action other repos run on
every PR. A bug here breaks reviews everywhere, so weigh each change against that
blast radius.

How it's laid out:

- `run.mjs` — the runner: gathers PR context, composes the prompt, runs Claude Code, posts the review.
- `scope.mjs` — pure helpers (diff scoping, comment placement), covered by `scope.test.mjs`.
- `prompt/header.md` + `prompt/footer.md` — the protocol wrapped around each consumer repo's standards.
- `action.yml` — inputs and steps. `docs/ai-review.md` — this file, our own standards.

**The default verdict is `REQUEST_CHANGES`.** Approve only when you'd ship the
change as-is with no open threads. Read the diff once and check:

- **Don't break the runner.** `run.mjs` posts real reviews through the GitHub API. Trace the change through the path it touches — context gathering, prompt assembly, verdict submission. A silent failure here means a PR ships unreviewed.
- **Keep it dependency-free.** This action installs nothing but Claude Code. Reject new npm dependencies unless there's genuinely no alternative.
- **Pure logic gets a test.** Changes to `scope.mjs` (or any pure helper) need a `scope.test.mjs` case — a bug in diff scoping posts comments on the wrong lines.
- **The prompt fragments are load-bearing.** Edits to `prompt/header.md`, `prompt/footer.md`, or this file change how *every* consumer is reviewed. Confirm the layers still compose into a coherent prompt with the output format intact.
- **Security.** It handles auth tokens and feeds untrusted PR diffs to the model — no logging secrets, no letting PR content break out of a shell.
- **Docs match the code.** If inputs, setup, or the release flow change, update `README.md` in the same PR.
- **Simpler is better.** Less code, fewer branches, no speculative options.

When the diff hints at a problem you can't confirm, ask inline and
`REQUEST_CHANGES` rather than guessing. No sub-agent fan-out here — this is a
small repo, so review it directly.
