# AI Code Review

A tireless senior engineer on every pull request.

It reads the whole PR. It catches bugs, security holes, missing tests, sloppy
code. Then it gives one verdict: **approve** or **request changes**. Comments
land inline, on the lines that matter.

No waiting. No rubber-stamps. No bad days. The same bar, every time.

This is the gate that makes hands-off shipping safe. An agent opens the PR. The
reviewer checks it. The agent fixes what it flags and tries again. An approval
auto-merges — no one touches a button. The comments aren't just a verdict.
They're the feedback the agent acts on to close the loop.

Runs in your own GitHub Actions. Your code never leaves your repo. It's the
reviewer that builds and merges [human0](https://human0.ai) itself — here's
[how and why we open-sourced it](https://human0.ai/blog/open-source-ai-code-review-github-action/).

> **Want the whole loop, not just the reviewer?** Start from the
> [human0 template](https://github.com/human0-ai/template). It wires up the
> reviewer, the agent guidelines, and an autonomous build-review-merge workflow —
> describe a change, an agent builds it, and it ships itself. This action is just
> the gate; the template is the full machine.

## What you get

- **Reviewed in seconds** — every PR, day or night. No waiting on a free pair of eyes.
- **Catches what matters** — bugs, security holes, missing tests, broken conventions.
- **Your bar, your rules** — define what "good" means in one plain-language doc. No code, and held every time.
- **Never tires, never skips** — the same careful read on PR #1 and PR #1,000.
- **Feedback an agent can act on** — clear inline comments it reads, fixes, and re-submits against.
- **Hands-free shipping** — an approval auto-merges. No one clicks the button.
- **Reviews only what changed** — after approval, later pushes get a quick pass over the new commits.
- **Yours, end to end** — your account, open source, Apache 2.0. Bring your own key.

## Set it up

1. **Add a credential** — **Settings → Secrets and variables → Actions**, add one of:
   - `ANTHROPIC_API_KEY` — an [Anthropic API key](https://console.anthropic.com/), or
   - `CLAUDE_CODE_OAUTH_TOKEN` — a Claude.ai OAuth token (`claude setup-token`).

2. **Add your standards** — copy
   [`docs/ai-review.md`](https://github.com/human0-ai/template/blob/main/docs/ai-review.md)
   from the template into your repo and tailor it to your project. This is what
   the reviewer holds the line on (see below).

3. **Allow Actions to approve PRs** — **Settings → Actions → General → Workflow
   permissions** → enable **"Allow GitHub Actions to create and approve pull
   requests."** In an organization, set this at the org level. Without it the
   reviewer can't approve.

4. **Add the workflow** at `.github/workflows/ai-review.yml`:

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

permissions:
  contents: write
  pull-requests: write
  checks: read

jobs:
  review:
    if: ${{ !github.event.pull_request.draft && !contains(github.event.pull_request.labels.*.name, 'no-ai-review') }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    concurrency:
      group: ai-review-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - uses: human0-ai/code-review@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ github.token }}
          pr_number: ${{ github.event.pull_request.number }}
          head_sha: ${{ github.event.pull_request.head.sha }}
          repo: ${{ github.repository }}
          prompt_file: docs/ai-review.md
```

5. **Open a PR.** The reviewer runs on the next push. To let an approval merge on
   its own, turn on **auto-merge** and require the review in branch protection.

> Tip: add a `no-ai-review` label to a PR to skip the reviewer on it.

## Change how it reviews — edit one doc

Want it stricter? Pickier about tests? Quiet on style? Edit `docs/ai-review.md`.
That one file is the bar, what to check, your conventions — in plain language. No
code, no config. Start from the template's and make it yours.

It also reads your `AGENTS.md` / `CLAUDE.md` on every run, so house rules written
there are followed for free.

For the full setup — reviewer, guidelines, and the autonomous workflow wired
together — fork the [human0 template](https://github.com/human0-ai/template).

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `github_token` | yes | Token used to read the PR and post the review. Use `${{ github.token }}`. |
| `pr_number` | yes | Pull request number. |
| `head_sha` | yes | Head commit SHA of the PR. |
| `repo` | yes | Repository in `owner/name` form. |
| `anthropic_api_key` | one of | Anthropic API key. |
| `claude_code_oauth_token` | one of | Claude.ai OAuth token. |
| `prompt_file` | yes | Path in your repo to your standards (e.g. `docs/ai-review.md`). |

Provide **either** `anthropic_api_key` **or** `claude_code_oauth_token`.

## Contributing

A small Node action — `run.mjs` plus helpers in `scope.mjs` (tested in
`scope.test.mjs`, no dependencies). Run `npm run lint && npm test`; CI runs both
on every PR. Releases are driven by `package.json`: bump the `version` in a PR,
and merging it tags and releases that version and re-points the floating `@v1`
tag.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
