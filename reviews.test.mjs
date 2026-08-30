import { test } from "node:test";
import assert from "node:assert/strict";
import { staleBlockingReviews, blockingReviewsToClear } from "./reviews.mjs";

const BOT = "github-actions[bot]";
const HEAD = "c58da0aa627462c6c92518c68505bb7ac84c8357";

const review = (over) => ({
  id: 1,
  user: BOT,
  state: "CHANGES_REQUESTED",
  commit_id: "5e7b12c7000000000000000000000000000000aa",
  ...over,
});

test("picks the bot's objection against an older head", () => {
  const stale = staleBlockingReviews([review()], { headSha: HEAD, botLogin: BOT });
  assert.deepEqual(stale.map((r) => r.id), [1]);
});

test("leaves an objection against the current head alone", () => {
  const stale = staleBlockingReviews([review({ commit_id: HEAD })], {
    headSha: HEAD,
    botLogin: BOT,
  });
  assert.deepEqual(stale, []);
});

test("ignores other reviewers and non-blocking states", () => {
  const reviews = [
    review({ id: 2, user: "moshest" }),
    review({ id: 3, state: "COMMENTED" }),
    review({ id: 4, state: "APPROVED" }),
    review({ id: 5, state: "DISMISSED" }),
  ];
  assert.deepEqual(staleBlockingReviews(reviews, { headSha: HEAD, botLogin: BOT }), []);
});

test("skips reviews with no usable id", () => {
  assert.deepEqual(
    staleBlockingReviews([review({ id: undefined })], { headSha: HEAD, botLogin: BOT }),
    [],
  );
});

test("returns nothing without a head sha or bot login", () => {
  assert.deepEqual(staleBlockingReviews([review()], { botLogin: BOT }), []);
  assert.deepEqual(staleBlockingReviews([review()], { headSha: HEAD }), []);
  assert.deepEqual(staleBlockingReviews(null, { headSha: HEAD, botLogin: BOT }), []);
});

test("blockingReviewsToClear takes current-head objections too, minus the review just submitted", () => {
  const reviews = [
    review({ id: 1 }),
    review({ id: 2, commit_id: HEAD }),
    review({ id: 3, state: "APPROVED", commit_id: HEAD }),
  ];
  assert.deepEqual(
    blockingReviewsToClear(reviews, { botLogin: BOT, keepReviewId: 3 }).map((r) => r.id),
    [1, 2],
  );
  assert.deepEqual(
    blockingReviewsToClear(reviews, { botLogin: BOT, keepReviewId: 2 }).map((r) => r.id),
    [1],
  );
});
