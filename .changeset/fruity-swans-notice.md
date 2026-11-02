---
"@mzwing/dsh-auto-review": patch
---

fix(dsh-auto-review): never resend a request the provider refused

A review retried every failure outside a short list DSH names as permanent. A request Claude refused, which the pi-ai adapter reports under its catch-all `PI_AI_ERROR`, therefore went out again up to `maxRetries` times, each time drawing another refusal on the account. A failed call is now retried only for the codes DSH's own retries resend by default: `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` and `TRANSPORT`. A refusal, or any other failure a retry cannot change, falls to you at once.
