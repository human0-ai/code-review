// Review-state helpers.
//
// GitHub counts only a reviewer's *most recent* review when it decides whether
// a PR is approved or blocked. A CHANGES_REQUESTED the bot left days and
// several rebases ago therefore keeps blocking a PR whose current head is
// clean — nothing the author does clears it, because the objection is attached
// to code that no longer exists. These helpers pick out exactly those stale
// reviews so the run can dismiss them.

/** The review states GitHub treats as a standing objection. */
const BLOCKING_STATE = "CHANGES_REQUESTED";

/**
 * The bot's own CHANGES_REQUESTED reviews that no longer speak about the
 * current head.
 *
 * A review is stale when it was submitted against a different commit than the
 * one being reviewed now. A review on the *current* head is left alone: it is
 * a live objection about the code as it stands, and dismissing it would be
 * the bot overruling itself.
 */
export function staleBlockingReviews(reviews, { headSha, botLogin } = {}) {
  if (!Array.isArray(reviews) || !headSha || !botLogin) return [];
  return reviews.filter(
    (r) =>
      r &&
      r.user === botLogin &&
      r.state === BLOCKING_STATE &&
      typeof r.id === "number" &&
      r.commit_id !== headSha,
  );
}

/**
 * Every standing objection from the bot, current head included — what an
 * APPROVE has to clear. GitHub does supersede an earlier review by the same
 * reviewer with a newer one, but only reliably once the newer review is the
 * latest; dismissing explicitly makes the outcome independent of that
 * ordering, and of branch-protection settings that count dismissed reviews
 * differently.
 */
export function blockingReviewsToClear(reviews, { botLogin, keepReviewId } = {}) {
  if (!Array.isArray(reviews) || !botLogin) return [];
  return reviews.filter(
    (r) =>
      r &&
      r.user === botLogin &&
      r.state === BLOCKING_STATE &&
      typeof r.id === "number" &&
      r.id !== keepReviewId,
  );
}
