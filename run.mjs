import { execSync, spawn, spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  renderThread,
  buildDiffScope,
  formatScopeSection,
  partitionComments,
  foldIntoBody,
} from "./scope.mjs";
import { staleBlockingReviews, blockingReviewsToClear } from "./reviews.mjs";

const REPO = requireEnv("REPO");
const PR_NUMBER = requireEnv("PR_NUMBER");
const HEAD_SHA = requireEnv("HEAD_SHA");
const PROMPT_FILE = resolvePromptFile();
const REVIEW_FILE = "/tmp/review.json";

// Inline cap — overflow is folded into the review body.
const MAX_INLINE_COMMENTS = 8;

// The identity reviews are submitted under when the action runs on the
// workflow token.
const BOT_LOGIN = "github-actions[bot]";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

// The review prompt is owned by the consumer repo — there is no default. Each
// repo keeps its own prompt (e.g. docs/ai-review.md) so it can evolve with the
// project. Fail fast if it's missing rather than reviewing against a stand-in.
function resolvePromptFile() {
  const file = (process.env.PROMPT_FILE || "").trim();
  if (!file) {
    throw new Error(
      "prompt_file is required: point it at a review prompt in your repo (e.g. docs/ai-review.md). " +
        "Copy one from https://github.com/human0-ai/template to get started.",
    );
  }
  if (!existsSync(file)) {
    throw new Error(
      `prompt_file "${file}" was not found in the repository. Add it (e.g. docs/ai-review.md) — ` +
        "copy one from https://github.com/human0-ai/template to get started.",
    );
  }
  return file;
}

function gh(args) {
  return execSync(`gh ${args}`, { encoding: "utf-8" }).trim();
}

function ghSafe(args) {
  try {
    return gh(args);
  } catch {
    return "";
  }
}

// argv-style invocation avoids shell-quoting the GraphQL body and user-authored
// reply text — safer than interpolating into a shell string.
function ghSpawn(argv) {
  const result = spawnSync("gh", argv, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `gh exited ${result.status}`);
  }
  return result.stdout.trim();
}

/** Review ids already dismissed this run, so a later pass can't re-send them. */
const dismissedReviewIds = new Set();

/**
 * Drop the bot's stale CHANGES_REQUESTED reviews.
 *
 * `message` is a callback taking the review, so each dismissal names the commit
 * that review was actually submitted against.
 *
 * `dismiss` needs pull-requests:write, which the action already requires to
 * submit reviews at all. Failures log and continue: a PR left blocked is worse
 * than the current behaviour, but it is not worth losing the review over.
 * Returns the number actually dismissed.
 */
function dismissReviews(list, message) {
  let dismissed = 0;
  for (const review of list) {
    if (dismissedReviewIds.has(review.id)) continue;
    try {
      ghSpawn([
        "api",
        "--method",
        "PUT",
        `repos/${REPO}/pulls/${PR_NUMBER}/reviews/${review.id}/dismissals`,
        "-f",
        `message=${typeof message === "function" ? message(review) : message}`,
        "-f",
        "event=DISMISS",
      ]);
      dismissed += 1;
      dismissedReviewIds.add(review.id);
      console.log(
        `Dismissed stale ${review.state} review ${review.id} (against ${(review.commit_id || "?").slice(0, 7)}).`,
      );
    } catch (e) {
      console.log(
        `Failed to dismiss review ${review.id}: ${e.message.split("\n")[0]}`,
      );
    }
  }
  return dismissed;
}

/** Dismiss objections the bot left against an older head. */
function dismissStaleObjections() {
  const stale = staleBlockingReviews(reviewObjects, {
    headSha: HEAD_SHA,
    botLogin: BOT_LOGIN,
  });
  if (!stale.length) return 0;
  const count = dismissReviews(
    stale,
    (review) =>
      `Superseded: this review was submitted against ${(review.commit_id || "an earlier commit").slice(0, 7)}, and the PR head is now ${HEAD_SHA.slice(0, 7)}. Dismissing it so it can't block a head it never looked at; the review for the current head stands on its own.`,
  );
  console.log(`REVIEW_METRICS dismissed_stale=${count}`);
  return count;
}

// argv-style git invocation — paths from `git diff --name-only` can contain
// spaces or other shell-meaningful characters, so never interpolate into a shell.
function gitSafe(argv) {
  const result = spawnSync("git", argv, { encoding: "utf-8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

// Variant that distinguishes "command failed" (e.g. unknown SHA) from
// "command succeeded with empty output" (tree-identical diff). Needed for
// the delta computation below — the empty-but-OK case means "nothing
// changed since approval" and should skip, while a failure means we lost
// context and should fall back to a full review.
function gitRun(argv) {
  const result = spawnSync("git", argv, { encoding: "utf-8" });
  return { ok: result.status === 0, output: (result.stdout || "").trim() };
}

function fetchReviewThreads(owner, repoName, prNumber) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:50,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id isResolved isOutdated path
          comments(first:50){
            nodes{databaseId author{login} body line originalLine}
          }
        }
      }
    }
  }
}`;
  const threads = [];
  let cursor = null;
  for (let safety = 0; safety < 20; safety++) {
    const argv = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-f", `repo=${repoName}`,
      "-F", `number=${prNumber}`,
    ];
    if (cursor) argv.push("-f", `cursor=${cursor}`);
    let resp;
    try {
      resp = JSON.parse(ghSpawn(argv));
    } catch (e) {
      console.log(`Failed to fetch review threads: ${e.message.split("\n")[0]}`);
      break;
    }
    const page = resp?.data?.repository?.pullRequest?.reviewThreads;
    if (!page) break;
    threads.push(...(page.nodes || []));
    if (!page.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return threads;
}

// --- Credential setup ---
// Accept either a Claude.ai OAuth token or an Anthropic API key. The OAuth
// token needs a credentials file; the API key is read straight from the
// ANTHROPIC_API_KEY env var by the CLI, so we only mark onboarding complete.
function setupCredentials() {
  const oauth = (process.env.CLAUDE_CODE_OAUTH_TOKEN || "").replace(/\s+/g, "");
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!oauth && !apiKey) {
    throw new Error(
      "Authentication required: set either claude_code_oauth_token or anthropic_api_key.",
    );
  }

  const home = homedir();
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
    { mode: 0o600 },
  );

  if (oauth) {
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: oauth,
          refreshToken: null,
          expiresAt: null,
          scopes: ["user:inference"],
        },
      }),
      { mode: 0o600 },
    );
  }
}

// Trim long strings so a single tool result can't drown the workflow log.
// The full transcript still lives in the agent's own state — this is just
// what we surface to the GitHub Actions UI.
function clip(text, max) {
  if (typeof text !== "string") text = JSON.stringify(text ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

function indent(text, prefix) {
  return text.split("\n").map((l) => `${prefix}${l}`).join("\n");
}

// Pretty-print one stream-json event from Claude Code so the workflow log
// reads like a transcript of the agent's reasoning, tool calls, and results.
function logStreamEvent(evt) {
  const type = evt?.type;
  if (type === "system" && evt.subtype === "init") {
    const tools = Array.isArray(evt.tools) ? evt.tools.join(", ") : "?";
    console.log(`▶ Claude session ready (model=${evt.model || "?"}, tools=${tools})`);
    return;
  }
  if (type === "assistant") {
    for (const block of evt.message?.content || []) {
      if (block.type === "text") {
        const text = (block.text || "").trim();
        if (text) console.log(`\n💭 Agent:\n${indent(text, "   ")}`);
      } else if (block.type === "tool_use") {
        const input = clip(JSON.stringify(block.input ?? {}), 600);
        console.log(`\n🔧 Tool ${block.name}: ${input}`);
      } else if (block.type === "thinking") {
        const text = (block.thinking || "").trim();
        if (text) console.log(`\n🧠 Thinking:\n${indent(clip(text, 1200), "   ")}`);
      }
    }
    return;
  }
  if (type === "user") {
    for (const block of evt.message?.content || []) {
      if (block.type === "tool_result") {
        const raw = typeof block.content === "string"
          ? block.content
          : (block.content || []).map((p) => p?.text ?? JSON.stringify(p)).join("\n");
        const status = block.is_error ? "❌" : "↳";
        const body = clip(raw.trim(), 800);
        console.log(`   ${status} result (${raw.length} chars): ${body.split("\n")[0]}`);
        const rest = body.split("\n").slice(1);
        if (rest.length) console.log(indent(rest.join("\n"), "     "));
      }
    }
    return;
  }
  if (type === "result") {
    const cost = typeof evt.total_cost_usd === "number" ? `$${evt.total_cost_usd.toFixed(4)}` : "?";
    const dur = typeof evt.duration_ms === "number" ? `${(evt.duration_ms / 1000).toFixed(1)}s` : "?";
    console.log(
      `\n🏁 Claude done — subtype=${evt.subtype} turns=${evt.num_turns ?? "?"} duration=${dur} cost=${cost}`,
    );
    if (evt.is_error) console.log(`   ⚠ result.is_error=true`);
    return;
  }
  // Anything else — log a one-liner so we don't silently drop events.
  console.log(`[${type || "unknown"}] ${clip(JSON.stringify(evt), 200)}`);
}

function runClaudeCli(prompt) {
  if (existsSync(REVIEW_FILE)) unlinkSync(REVIEW_FILE);
  // Task stays in the allowlist so the agent can spawn the sub-agent personas
  // (§3a) when it judges them worthwhile. Whether to fan out is the agent's
  // call — see "Follow-up vs full review" in docs/ai-review.md. Write is
  // required for the final /tmp/review.json verdict.
  //
  // stream-json + --verbose surfaces every assistant message, tool call, and
  // tool result in the workflow log via logStreamEvent. Without this, the log
  // only sees the script's own console.log lines — making failures opaque.
  return new Promise((resolve) => {
    console.log("\n=== AI Review Agent ===");
    const child = spawn(
      "claude",
      [
        "-p",
        "--model", "opus",
        "--allowedTools", "Task,Bash,Read,Glob,Grep,Write",
        "--max-turns", "50",
        "--output-format", "stream-json",
        "--verbose",
        // Required for headless CI — without this flag Claude Code prompts for
        // interactive approval on every tool call, which hangs the workflow.
        // Security is enforced via --allowedTools (restricted to read-only + Bash).
        "--dangerously-skip-permissions",
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );

    let buffer = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          logStreamEvent(JSON.parse(line));
        } catch {
          // Non-JSON bleed (rare) — surface it verbatim so it isn't lost.
          console.log(line);
        }
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(prompt);

    // 25 min — workflow has a 30 min timeout, leave a margin for posting.
    const killTimer = setTimeout(() => {
      console.error("Claude CLI timed out after 25 minutes — killing");
      child.kill("SIGKILL");
    }, 25 * 60 * 1000);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({ ok: false, payload: null, reason: `spawn error: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (buffer.trim()) {
        try {
          logStreamEvent(JSON.parse(buffer));
        } catch {
          console.log(buffer.trim());
        }
      }
      console.log("=== End agent output ===\n");
      if (code !== 0) {
        resolve({ ok: false, payload: null, reason: `claude exited with code ${code}` });
        return;
      }
      if (!existsSync(REVIEW_FILE)) {
        resolve({ ok: false, payload: null, reason: "no review file produced" });
        return;
      }
      try {
        resolve({ ok: true, payload: JSON.parse(readFileSync(REVIEW_FILE, "utf-8")), reason: null });
      } catch (e) {
        resolve({ ok: false, payload: null, reason: `parse error: ${e.message}` });
      }
    });
  });
}

// --- Step 1: Fetch PR context ---
const diff = ghSafe(`pr diff ${PR_NUMBER}`);
const changedFiles = ghSafe(`pr diff ${PR_NUMBER} --name-only`);

// Recent commit context — gives the reviewer a cheap signal of repo direction
// and per-file churn (frequent edits, recent reverts) without forcing a Bash
// round-trip. The checkout step uses fetch-depth: 0 so the full history is
// available locally.
const recentCommits = gitSafe(["log", "--oneline", "-20", "HEAD"]);
const changedFileList = changedFiles.split("\n").map((f) => f.trim()).filter(Boolean);
const fileChurn = changedFileList
  .slice(0, 10)
  .map((path) => {
    const log = gitSafe(["log", "--oneline", "-5", "--", path]);
    return log ? `**${path}**\n${log}` : null;
  })
  .filter(Boolean)
  .join("\n\n");
const fileChurnNote = changedFileList.length > 10
  ? `\n\n_(showing first 10 of ${changedFileList.length} changed files)_`
  : "";
// Fetch reviews as structured JSON so we can both (a) render them as the
// "### Previous reviews" string for the prompt and (b) inspect state +
// commit_id to detect post-approval incremental mode below.
const reviewsRaw = ghSafe(
  // --paginate --slurp: a long-lived PR easily passes one page of 30, and the
  // review that matters (the standing CHANGES_REQUESTED, or the last approval)
  // is on the last page. No --jq here — gh rejects it alongside --slurp — so
  // the pages are flattened and shaped in JS below.
  `api "repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100" --paginate --slurp`,
);
let reviewObjects = [];
try {
  const pages = JSON.parse(reviewsRaw || "[]");
  reviewObjects = (Array.isArray(pages) ? pages.flat() : [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      id: r.id,
      user: r.user?.login,
      state: r.state,
      body: r.body,
      commit_id: r.commit_id,
      submitted_at: r.submitted_at,
    }));
} catch {
  reviewObjects = [];
}
const reviews = reviewObjects
  .map((r) => `[${r.user || "?"}] ${r.state}: ${r.body || "(no body)"}`)
  .join("\n");

// Detect post-approval incremental mode. GitHub returns reviews in
// chronological order (oldest first). state==="APPROVED" only matches
// still-active approvals — GitHub flips dismissed ones to "DISMISSED"
// when new commits land (with branch protection's dismiss-stale setting),
// so we automatically fall back to full mode after a dismissal.
const botApprovals = reviewObjects.filter(
  (r) => r.user === BOT_LOGIN && r.state === "APPROVED",
);
const lastBotApproval = botApprovals.length
  ? botApprovals[botApprovals.length - 1]
  : null;

const sameShaAsApproval =
  lastBotApproval && lastBotApproval.commit_id === HEAD_SHA;
if (sameShaAsApproval) {
  // Redundant trigger — the bot already approved this exact SHA. Skip the
  // run entirely instead of posting a duplicate "still good" review.
  console.log(
    `Skipping review: bot already approved HEAD ${HEAD_SHA.slice(0, 7)} in review submitted at ${lastBotApproval.submitted_at}.`,
  );
  // Nothing newer is coming from this run, so clear the bot's stale
  // objections here or they keep blocking a head the bot has approved.
  dismissStaleObjections();
  console.log(`REVIEW_METRICS mode=skip-same-sha verdict=APPROVE`);
  process.exit(0);
}

let deltaDiff = "";
let isIncremental = false;
if (lastBotApproval && lastBotApproval.commit_id) {
  const { ok, output } = gitRun([
    "diff",
    `${lastBotApproval.commit_id}..${HEAD_SHA}`,
  ]);
  if (!ok) {
    // Couldn't compute the diff at all (e.g. the approved SHA isn't in the
    // local clone after a force-push). Safer to re-run the full review than
    // to silently skip.
    console.log(
      `Could not compute delta from ${lastBotApproval.commit_id.slice(0, 7)} to HEAD; falling back to full review.`,
    );
  } else if (output) {
    deltaDiff = output;
    isIncremental = true;
  } else {
    // Diff succeeded but produced no output — HEAD is tree-identical to the
    // approved SHA (revert-of-revert, no-op merge, etc.). Same outcome as
    // the same-SHA case: nothing new to review, skip.
    console.log(
      `Skipping review: HEAD ${HEAD_SHA.slice(0, 7)} is tree-identical to approved ${lastBotApproval.commit_id.slice(0, 7)}.`,
    );
    dismissStaleObjections();
    console.log(`REVIEW_METRICS mode=skip-tree-identical verdict=APPROVE`);
    process.exit(0);
  }
}

const [OWNER, REPO_NAME] = REPO.split("/");
const reviewThreads = fetchReviewThreads(OWNER, REPO_NAME, PR_NUMBER);
const openThreads = reviewThreads.filter((t) => !t.isResolved);
const resolvedThreads = reviewThreads.filter((t) => t.isResolved);
const openThreadsText = openThreads.length
  ? openThreads.map(renderThread).join("\n")
  : "None";
const resolvedThreadsText = resolvedThreads.length
  ? resolvedThreads.map(renderThread).join("\n")
  : "None";
const issueComments = ghSafe(
  `api "repos/${REPO}/issues/${PR_NUMBER}/comments" --jq '.[] | "[\\(.user.login)]: \\(.body)"'`,
);
const prTitle = ghSafe(
  `api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.title'`,
);
const prBody = ghSafe(
  `api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.body // "(no description)"'`,
);

const scope = buildDiffScope(diff);

// --- Step 2: Build prompt ---
// The prompt is composed in layers: the action's protocol header (how reviews
// run, the context spec, follow-up mechanics) + this repo's review standards
// (PROMPT_FILE) + the action's protocol footer (sub-agent process, scope rule,
// output format) + the injected PR context. The protocol ships with the action
// so consumer prompts hold only their standards instead of duplicating it.
const ACTION_DIR = dirname(fileURLToPath(import.meta.url));
const headerPrompt = readFileSync(join(ACTION_DIR, "prompt", "header.md"), "utf-8");
const footerPrompt = readFileSync(join(ACTION_DIR, "prompt", "footer.md"), "utf-8");
const standardsPrompt = readFileSync(PROMPT_FILE, "utf-8");
const mode = isIncremental ? "incremental" : "full";
console.log(
  `Review run: ${isIncremental ? `delta since ${lastBotApproval.commit_id.slice(0, 7)}` : "full"}`,
);
const fullPrompt = [
  headerPrompt,
  `\n---\n\n# Repository review guidance\n\n${standardsPrompt}`,
  `\n---\n\n${footerPrompt}`,
  `\n---\n\n## PR #${PR_NUMBER}: ${prTitle || "(unknown)"}\n`,
  `### Description\n${prBody}`,
  `\n### Changed files\n${changedFiles}`,
  `\n### Recent repo commits (last 20)\n\`\`\`\n${recentCommits || "(none)"}\n\`\`\``,
  `\n### Recent commits on changed files (last 5 each)\n${fileChurn || "(none)"}${fileChurnNote}`,
  `\n### Diff\n\`\`\`diff\n${diff}\n\`\`\``,
  ...(isIncremental
    ? [
        `\n### Last approval\nCommit: ${lastBotApproval.commit_id}\nSubmitted: ${lastBotApproval.submitted_at}\n\n${lastBotApproval.body || "(no body)"}`,
        `\n### Delta since last approval\n\`\`\`diff\n${deltaDiff}\n\`\`\``,
      ]
    : []),
  `\n### In-scope lines\nOnly post inline comments on these new-side line ranges. Findings outside these ranges are folded into the review body rather than posted inline — drop them yourself instead of relying on the fold.\n\n${formatScopeSection(scope.ranges)}`,
  `\n### Previous reviews\n${reviews || "None"}`,
  `\n### Open review threads\n${openThreadsText}`,
  `\n### Resolved review threads\n${resolvedThreadsText}`,
  `\n### Previous issue comments\n${issueComments || "None"}`,
  `\nUse these values:\n- commit_id: ${HEAD_SHA}\n- repo: ${REPO}\n- PR number: ${PR_NUMBER}`,
].join("\n");

// --- Step 3: Run Claude Code CLI ---
setupCredentials();

const cliResult = await runClaudeCli(fullPrompt);
if (!cliResult.ok) {
  console.error(`Claude run failed: ${cliResult.reason}`);
  process.exit(1);
}

const reviewPayload = cliResult.payload;
const verdict = reviewPayload.event;
if (verdict !== "APPROVE" && verdict !== "REQUEST_CHANGES") {
  console.error(`Unexpected event in verdict: ${verdict}`);
  process.exit(1);
}
console.log(`\n=== Review verdict: ${verdict} ===`);
if (reviewPayload.body) {
  console.log(`Body:\n${indent(reviewPayload.body, "  ")}`);
}
const allComments = Array.isArray(reviewPayload.comments) ? reviewPayload.comments : [];
if (allComments.length) {
  console.log(`Inline comments (${allComments.length}):`);
  for (const c of allComments) {
    const body = clip((c?.body || "").trim(), 300);
    console.log(`  • ${c?.path || "?"}:${c?.line ?? "?"} — ${body}`);
  }
}
const plannedReplies = Array.isArray(reviewPayload.replies) ? reviewPayload.replies : [];
if (plannedReplies.length) {
  console.log(`Thread replies (${plannedReplies.length}):`);
  for (const r of plannedReplies) {
    console.log(`  • → ${r?.in_reply_to}: ${clip((r?.body || "").trim(), 200)}`);
  }
}
const plannedResolves = Array.isArray(reviewPayload.resolve) ? reviewPayload.resolve : [];
if (plannedResolves.length) {
  console.log(`Threads to resolve (${plannedResolves.length}): ${plannedResolves.join(", ")}`);
}
console.log("");

const replies = Array.isArray(reviewPayload.replies) ? reviewPayload.replies : [];
const resolves = Array.isArray(reviewPayload.resolve) ? reviewPayload.resolve : [];
let { kept, folded } = partitionComments(reviewPayload.comments, scope.allowed);

// Clip to the inline cap — overflow joins the folded set so it still reaches
// the author via the body rather than drowning the PR inline.
if (kept.length > MAX_INLINE_COMMENTS) {
  folded = [...kept.slice(MAX_INLINE_COMMENTS), ...folded];
  kept = kept.slice(0, MAX_INLINE_COMMENTS);
}

// --- Step 4: Submit review ---
delete reviewPayload.replies;
delete reviewPayload.resolve;
reviewPayload.comments = kept;
reviewPayload.body = foldIntoBody(reviewPayload.body, folded);
if (!reviewPayload.commit_id) reviewPayload.commit_id = HEAD_SHA;
if (folded.length) {
  console.log(`Folded ${folded.length} unresolvable inline comment(s) into the review body.`);
}

writeFileSync(REVIEW_FILE, JSON.stringify(reviewPayload));

// Submit the review — pipeline handles this to guarantee it's always posted
const submitted = gh(
  `api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --method POST --input ${REVIEW_FILE}`,
);
console.log("Review submitted");

let submittedReviewId = null;
try {
  const parsed = JSON.parse(submitted);
  submittedReviewId = typeof parsed?.id === "number" ? parsed.id : null;
  if (verdict === "APPROVE" && parsed?.state && parsed.state !== "APPROVED") {
    // Loud, because it is the failure this whole path exists to prevent: a
    // clean PR that stays blocked because the approval landed as a comment.
    console.log(
      `WARNING: APPROVE verdict was recorded as "${parsed.state}" — the PR will stay blocked. ` +
        "A workflow token cannot approve a PR it authored; run the action under an app or PAT identity for those.",
    );
  }
} catch {
  // Non-JSON output (older gh, or an empty body) — nothing to read, and the
  // review itself went through.
}

// Only now, with this run's verdict on the record, drop the bot's objections
// against heads that no longer exist. Doing it earlier would leave a window
// where the PR reads unblocked but unreviewed, and auto-merge could land the
// new head before the verdict arrives.
dismissStaleObjections();

// An APPROVE also has to clear objections against *this same head* — left by
// an earlier run whose findings are now addressed or withdrawn — or GitHub
// keeps the PR blocked on a review the bot itself no longer stands behind.
if (verdict === "APPROVE") {
  // `reviewObjects` is the pre-run snapshot, so anything already dismissed
  // above is filtered out by `dismissReviews` itself — re-sending those would
  // 422 and undercount.
  const standing = blockingReviewsToClear(reviewObjects, {
    botLogin: BOT_LOGIN,
    keepReviewId: submittedReviewId,
  }).filter((r) => !dismissedReviewIds.has(r.id));
  const cleared = dismissReviews(
    standing,
    `Withdrawn: a later review of ${HEAD_SHA.slice(0, 7)} found nothing to change, so this objection no longer stands.`,
  );
  if (standing.length) {
    console.log(`REVIEW_METRICS dismissed_on_approve=${cleared}`);
  }
}

// Dispatch replies to existing threads. Failures log + continue so one bad
// ID doesn't hide a successful review.
for (const r of replies) {
  if (!r?.in_reply_to || !r?.body) {
    console.log(`Skipping malformed reply: ${JSON.stringify(r)}`);
    continue;
  }
  try {
    ghSpawn([
      "api", "--method", "POST",
      `repos/${REPO}/pulls/${PR_NUMBER}/comments/${r.in_reply_to}/replies`,
      "-f", `body=${r.body}`,
    ]);
    console.log(`Replied to comment ${r.in_reply_to}`);
  } catch (e) {
    console.log(`Failed to reply to ${r.in_reply_to}: ${e.message.split("\n")[0]}`);
  }
}

// Dispatch thread resolves via GraphQL. Requires `contents: write` on the
// workflow token — without it the mutation returns 403; log and continue.
const resolveMutation = `mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}`;
for (const tid of resolves) {
  if (typeof tid !== "string" || !tid) {
    console.log(`Skipping malformed resolve: ${JSON.stringify(tid)}`);
    continue;
  }
  try {
    ghSpawn([
      "api", "graphql",
      "-f", `query=${resolveMutation}`,
      "-f", `tid=${tid}`,
    ]);
    console.log(`Resolved thread ${tid}`);
  } catch (e) {
    console.log(
      `Failed to resolve thread ${tid}: ${e.message.split("\n")[0]} (needs contents:write permission)`,
    );
  }
}

// Greppable telemetry across Actions runs — tracks whether the fix bites.
console.log(
  `REVIEW_METRICS mode=${mode} total=${kept.length + folded.length} kept=${kept.length} folded=${folded.length} verdict=${verdict}`,
);

// Exit 0 in both APPROVE and REQUEST_CHANGES cases — the verdict is signal
// for the author, not a CI gate.
process.exit(0);
