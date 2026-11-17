---
"@mzwing/dsh-auto-review": patch
---

chore(dsh-auto-review): reconcile the bundled Guardian policy against openai/codex@e54a5713

Upstream simplified the Guardian outcome policy's post-denial approval rule (openai/codex#60391): re-approving a previously denied action after seeing the concrete risk sets user authorization to `high`, and the rule no longer repeats that the approval must be explicit, cover the exact action, and come from the user beyond doubt, since the authorization scoring rules still require those. The `codex` preset's adapted prompt simplifies its post-denial rule the same way while still keeping re-approval from lifting a denial for a critical action or an absolute (`hard_deny`) rule, and the policy revision shown in the review log and the `/auto-review` status becomes `openai-codex/e54a5713caf331f42a6eef0166186df5f7563c29+dsh2`.
