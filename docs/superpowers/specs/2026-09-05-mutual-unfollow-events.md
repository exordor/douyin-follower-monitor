# Mutual-unfollow event specification

## User outcome

The monitor must highlight the high-value case where an account was explicitly observed as mutually following the user and is later confirmed to have stopped following the user.

## Evidence boundary

- Existing follower rows predate relationship capture and remain `unknown`; no historical event is backfilled.
- The collector may classify a follower as `mutual` only from an explicit Douyin API relationship signal. Missing, unsupported, or ambiguous signals remain `unknown` and never overwrite a previously known relationship.
- A `mutual_unfollowed_you` event is emitted only when the normal removal state machine reaches confirmed removal after two complete full scans.
- Recent, incomplete, interrupted, hidden, and temporarily unavailable observations do not independently create the event.
- The event is prospective: the first successful CDP full scan after deployment establishes the relationship baseline.

## Data contract

- `relationshipStatus`: `unknown | mutual | follower_only` on follower records.
- `relationshipObservedAt`: timestamp of the latest recognized relationship signal.
- API normalization recognizes numeric `followStatus` or `follow_status`: `2` is `mutual`, `0` is `follower_only`, all other values are `unknown`.
- Event type: `mutual_unfollowed_you`.
- The special event is recorded alongside the existing `removed` event so existing removal counts and consumers remain compatible.

## Dashboard and notification behavior

- The event filter and event table display `互关后取关我` with a high-priority visual treatment.
- Run detail and latest-change summaries expose a separate mutual-unfollow count.
- Completion notifications include the mutual-unfollow count when it is greater than zero.
- No account identifiers, nicknames, profile URLs, cookie names, or cookie values are added to logs.

## Compatibility

- SQLite schema migrates in place from version 1 to version 2.
- Existing rows receive `relationshipStatus = 'unknown'` and `relationshipObservedAt = NULL`.
- No new dependency is added.
