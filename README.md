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

2. **Add the workflow** at `.github/workflows/ai-review.yml`:

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

      - uses: human0-ai/code-review@main
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ github.token }}
          pr_number: ${{ github.event.pull_request.number }}
          head_sha: ${{ github.event.pull_request.head.sha }}
          repo: ${{ github.repository }}
```

3. **Open a PR.** The reviewer runs on the next push and posts its verdict.

To turn an `APPROVE` into an automatic merge, enable **auto-merge** on the PR and
require the review in your branch protection rules.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `github_token` | yes | Token used to read the PR and post the review. Use `${{ github.token }}`. |
| `pr_number` | yes | Pull request number. |
| `head_sha` | yes | Head commit SHA of the PR. |
| `repo` | yes | Repository in `owner/name` form. |
| `anthropic_api_key` | one of | Anthropic API key. |
| `claude_code_oauth_token` | one of | Claude.ai OAuth token. |
| `prompt_file` | no | Path in your repo to a custom review prompt. Defaults to the prompt bundled with this action. |

Provide **either** `anthropic_api_key` **or** `claude_code_oauth_token`.

## Customizing the review

The reviewer's behavior is just a prompt. To tune it — adjust the bar, add
project-specific rules, change tone — copy [`review-prompt.md`](./review-prompt.md)
into your repo (e.g. `docs/ai-review.md`), edit it, and point the action at it:

```yaml
      - uses: human0-ai/code-review@main
        with:
          # ...
          prompt_file: docs/ai-review.md
```

The reviewer reads your repo's `AGENTS.md` (or `CLAUDE.md`) on every run, so the
fastest way to teach it your conventions is to write them there — no prompt
edits needed.

## How it works

- Runs on every non-draft PR (add a `no-ai-review` label to skip one).
- Posts inline comments only on lines the PR actually changed.
- After it approves a PR, later pushes get an **incremental** review — it only
  re-reads what changed since its last approval instead of re-auditing the whole
  diff.
- Replies on existing review threads and resolves them as they're addressed,
  so the conversation reads like a human back-and-forth.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
