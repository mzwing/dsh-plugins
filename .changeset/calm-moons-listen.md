---
"@mzwing/dsh-model-info": patch
---

fix(dsh-model-info): fix startup failure during config resolution

DSH startup failed with "Cannot read properties of null (reading 'runtime')" because Cordis calls the `internal/config` hook with a null receiver and the fiber as its first argument.
