---
"@mzwing/dsh-auto-review": patch
---

fix(dsh-auto-review): stop Claude from refusing the `claude-code` second pass

The second pass asked the reviewer to write its reasoning in `<thinking>` tags in its reply. Claude Sonnet 5.5 and other recent Claude models refuse that as reasoning extraction before answering, so no call the fast pass flagged got a verdict, and each fell to you once the review failed.

The second pass now reasons natively, at `reasoningEffort` when it is set and at the model's default otherwise, where it used the least effort before. The policy revision becomes `claude-code/2.1.314+dsh2`.
