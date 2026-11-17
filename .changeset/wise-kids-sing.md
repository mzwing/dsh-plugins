---
"@mzwing/dsh-auto-review": patch
---

fix(dsh-auto-review): attribute delegated prompts the way the built-in Auto review does since DSH 0.2.2

A forked child inherits its parent's log, so the task an earlier child was created with could reach the reviewer as the user's own words and vouch for the child's actions. Every creation prompt in the log, inherited ones included, is now shown as unverified context. A child whose own creation prompt cannot be found shows its own user-role prompts the same way, so the reviewer no longer gives them the user's authority. Prompts the Web client submitted still count as the user's.

A delegated child's call that fails because its review could not decide now carries the `AutoReviewFailedError` / `AUTO_REVIEW_FAILED` identity, the same one the built-in Auto review uses, so it no longer looks like a plain failed call.
