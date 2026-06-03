# human0 AI Code Review

An autonomous AI reviewer for your pull requests. It reads every PR like a
skeptical senior engineer — checking correctness, security, architecture,
simplicity, tests, and docs — then posts inline comments and a single verdict:
**APPROVE** or **REQUEST_CHANGES**.

Pair it with branch protection and auto-merge and you get a review gate that
runs in seconds, 24/7, in your own GitHub Actions. No code leaves your repo.

This is the reviewer that ships and merges [human0](https://human0.ai) itself.
For a full repository template wired up to use it, start with
[human0-ai/template](https://github.com/human0-ai/template).

## Quick start

1. **Add a credential.** In your repo, go to **Settings → Secrets and variables
   → Actions** and add one of:
   - `ANTHROPIC_API_KEY` — an [Anthropic API key](https://console.anthropic.com/), or
   - `CLAUDE_CODE_OAUTH_TOKEN` — a Claude.ai OAuth token (`claude setup-token`).

2. **Add your review prompt.** The action ships **no** default prompt — each repo
   owns its own so it can evolve with the project. Copy
   [`docs/ai-review.md`](https://github.com/human0-ai/template/blob/main/docs/ai-review.md)
   from the template into your repo, then review and tailor it before your first run.

3. **Add the workflow** at `.github/workflows/ai-review.yml`:

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

permissions:
  # contents:write is needed to resolve review threads via GraphQL.
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

4. **Open a PR.** The reviewer runs on the next push and posts its verdict.

To turn an `APPROVE` into an automatic merge, enable **auto-merge** on the PR and
require the review in your branch protection rules.

## Repository settings

For the reviewer to **approve** PRs (which is what lets an approval auto-merge),
GitHub must allow Actions to approve pull requests:

**Settings → Actions → General → Workflow permissions** → enable
**"Allow GitHub Actions to create and approve pull requests."**

In an organization this is often locked at the org level — set it under
**Organization → Settings → Actions → General** instead. You do **not** need to
switch the default token to "Read and write": the workflow already requests the
`contents`/`pull-requests` write scopes it needs via its `permissions:` block.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `github_token` | yes | Token used to read the PR and post the review. Use `${{ github.token }}`. |
| `pr_number` | yes | Pull request number. |
| `head_sha` | yes | Head commit SHA of the PR. |
| `repo` | yes | Repository in `owner/name` form. |
| `anthropic_api_key` | one of | Anthropic API key. |
| `claude_code_oauth_token` | one of | Claude.ai OAuth token. |
| `prompt_file` | yes | Path in your repo to your review prompt (e.g. `docs/ai-review.md`). No default — the action requires this. |

Provide **either** `anthropic_api_key` **or** `claude_code_oauth_token`.

## What's in the prompt

The review prompt is composed in layers, so you only write the part that's
yours:

1. **Protocol — from this action.** The context the runner injects, how review
   scope works, the sub-agent process, and the exact output format. You don't
   write or maintain this; it ships with the action and is the same everywhere.
2. **Your standards — `prompt_file`.** The bar and what to check. This is the
   only part you own, and it stays short (see the template's `docs/ai-review.md`,
   ~50 lines) because it holds standards, not mechanics.

Tuning the reviewer — the bar, project-specific rules, tone — is a normal edit to
your `prompt_file`. Because the reviewer runs against the prompt on the PR
branch, you can refine it in the same PR it reviews.

The reviewer also reads your repo's `AGENTS.md` (or `CLAUDE.md`) on every run, so
the fastest way to teach it your conventions is to write them there.

## How it works

- Runs on every non-draft PR (add a `no-ai-review` label to skip one).
- Posts inline comments only on lines the PR actually changed.
- After it approves a PR, later pushes get an **incremental** review — it only
  re-reads what changed since its last approval instead of re-auditing the whole
  diff.
- Replies on existing review threads and resolves them as they're addressed,
  so the conversation reads like a human back-and-forth.

## Development

The reviewer logic lives in `run.mjs`; its pure helpers (diff scoping, comment
placement) are in `scope.mjs` and covered by `scope.test.mjs`. No dependencies —
tests use the Node built-in runner.

```bash
npm run lint   # syntax check
npm test       # node --test
```

CI runs both on every PR.

## Releasing

Push a semver tag and the [release workflow](.github/workflows/release.yml)
verifies the action and moves the floating major tag for you:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

`v1` is then re-pointed at that commit, so consumers pinned to `@v1` pick up the
release automatically. Always pin by major tag (`@v1`), not `@main`.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
