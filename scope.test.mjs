import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffScope,
  formatScopeSection,
  partitionComments,
  foldIntoBody,
} from "./scope.mjs";

const DIFF = `diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
diff --git a/bar.js b/bar.js
--- a/bar.js
+++ b/bar.js
@@ -10,3 +10,2 @@
 line10
-removed
 line11
`;

test("buildDiffScope maps changed and context lines on the new side", () => {
  const { allowed } = buildDiffScope(DIFF);
  // Added + context lines are in scope.
  assert.ok(allowed.has("foo.js:1"));
  assert.ok(allowed.has("foo.js:2"));
  assert.ok(allowed.has("foo.js:3"));
  // A line past the hunk is not.
  assert.ok(!allowed.has("foo.js:4"));
});

test("buildDiffScope builds contiguous ranges and isn't split by deletions", () => {
  const { ranges } = buildDiffScope(DIFF);
  assert.deepEqual(ranges.get("foo.js"), [{ start: 1, end: 3 }]);
  // The `-removed` line must not split bar.js's range.
  assert.deepEqual(ranges.get("bar.js"), [{ start: 10, end: 11 }]);
});

test("buildDiffScope tolerates empty input", () => {
  const { allowed, ranges } = buildDiffScope("");
  assert.equal(allowed.size, 0);
  assert.equal(ranges.size, 0);
});

test("formatScopeSection renders single lines and ranges", () => {
  const { ranges } = buildDiffScope(DIFF);
  const out = formatScopeSection(ranges);
  assert.match(out, /- foo\.js: 1-3/);
  assert.match(out, /- bar\.js: 10-11/);
});

test("partitionComments keeps in-scope comments and folds the rest", () => {
  const allowed = new Set(["foo.js:2"]);
  const comments = [
    { path: "foo.js", line: 2, body: "in scope" },
    { path: "foo.js", line: 9, body: "out of scope" },
    { path: "other.js", line: 2, body: "wrong file" },
    { path: "foo.js", body: "no line" },
  ];
  const { kept, folded } = partitionComments(comments, allowed);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].body, "in scope");
  assert.equal(folded.length, 3);
});

test("foldIntoBody appends out-of-scope findings, and is a no-op when empty", () => {
  assert.equal(foldIntoBody("Body", []), "Body");
  const out = foldIntoBody("Summary", [{ path: "f.js", line: 9, body: "oops" }]);
  assert.match(out, /couldn't be posted inline/);
  assert.match(out, /`f\.js:9` — oops/);
});
