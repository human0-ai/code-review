// Pure helpers for diff scoping and review-comment placement.
//
// These are extracted from run.mjs so they can be unit-tested without spawning
// the CLI or hitting the GitHub API — run.mjs imports them back.

export function renderThread(t) {
  const lines = [`- Thread ${t.id} on ${t.path}${t.isOutdated ? " (outdated)" : ""}`];
  for (const c of t.comments?.nodes || []) {
    const loc = c.line ?? c.originalLine ?? "?";
    const body = (c.body || "").replace(/\s+/g, " ").slice(0, 400);
    lines.push(
      `  - [${c.author?.login || "unknown"}] id=${c.databaseId} L${loc}: ${body}`,
    );
  }
  return lines.join("\n");
}

// Walk the unified diff once and emit (a) the set of every valid (path, line)
// pair on the new side — the filter's source of truth — and (b) contiguous
// new-side line ranges per file, which we inject into the prompt so Claude
// knows exactly which lines are in scope before filing anything.
export function buildDiffScope(diffText) {
  const allowed = new Set();
  const ranges = new Map();
  let path = null;
  let newLine = 0;
  let inHunk = false;
  let rangeStart = 0;
  let prevLine = 0;

  function closeRange() {
    if (path && rangeStart) {
      const list = ranges.get(path) || [];
      list.push({ start: rangeStart, end: prevLine });
      ranges.set(path, list);
    }
    rangeStart = 0;
  }

  for (const line of (diffText || "").split("\n")) {
    if (line.startsWith("+++ b/")) {
      closeRange();
      path = line.slice(6);
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      closeRange();
      path = null;
      inHunk = false;
      continue;
    }
    const m = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/);
    if (m) {
      closeRange();
      newLine = parseInt(m[1], 10);
      inHunk = Boolean(path);
      continue;
    }
    if (!inHunk) continue;
    const ch = line.charAt(0);
    if (ch === "+" || ch === " ") {
      allowed.add(`${path}:${newLine}`);
      if (!rangeStart) rangeStart = newLine;
      prevLine = newLine;
      newLine++;
    } else if (ch === "-") {
      // Deletion doesn't advance the new-side counter and doesn't split a range.
    } else {
      closeRange();
      inHunk = false;
    }
  }
  closeRange();
  return { allowed, ranges };
}

// Cap an oversized diff before it goes into the prompt so a huge PR can't blow
// the model's context window. Truncates on a line boundary and appends a marker
// noting how much was dropped.
export function capDiff(diff, maxBytes = 60000) {
  if (!diff || diff.length <= maxBytes) return diff;
  const head = diff.slice(0, maxBytes);
  const lastNewline = head.lastIndexOf("\n");
  const trimmed = head.slice(0, lastNewline);
  const dropped = diff.length - trimmed.length;
  return `${trimmed}\n… (${dropped} bytes of diff truncated)`;
}

export function formatScopeSection(ranges) {
  if (!ranges.size) return "(no changed lines in diff)";
  const entries = [...ranges.entries()];
  const shown = entries.slice(0, 50);
  const lines = shown.map(([path, rs]) => {
    const parts = rs.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`));
    return `- ${path}: ${parts.join(", ")}`;
  });
  if (entries.length > shown.length) {
    lines.push(`- ... and ${entries.length - shown.length} more files (see Changed files above; all listed files are in scope)`);
  }
  return lines.join("\n");
}

// Partition inline comments into {kept, folded}. Folded comments go into the
// review body so the signal survives at PR level — GitHub would 422 the whole
// review if we tried to post them on lines outside the diff hunks.
export function partitionComments(comments, allowed) {
  const kept = [];
  const folded = [];
  for (const c of comments || []) {
    if (c?.path && typeof c.line === "number" && allowed.has(`${c.path}:${c.line}`)) {
      kept.push(c);
    } else {
      folded.push(c);
    }
  }
  return { kept, folded };
}

export function foldIntoBody(body, folded) {
  if (!folded.length) return body || "";
  const bullets = folded
    .map((c) => `- \`${c?.path || "?"}:${c?.line ?? "?"}\` — ${(c?.body || "").trim()}`)
    .join("\n");
  return `${body || ""}\n\n---\n**Findings that couldn't be posted inline** (line outside the diff):\n${bullets}`;
}
