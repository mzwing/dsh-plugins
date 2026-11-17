---
"@mzwing/dsh-auto-review": patch
"@mzwing/dsh-model-info": patch
---

chore: adapt DSH 0.2.2

dsh-auto-review now moves live Auto sessions to Workspace Write only when the plugin itself is removed. When DSH shuts down, it leaves their saved Auto setting alone, as the built-in Auto review does since 0.2.2, so they resume in Auto on the next start. Reviewer requests also carry the `auto-review` request purpose, so plugins that set pi-ai request headers by purpose can tell them apart from the main conversation.

dsh-model-info now requires DSH 0.2.2-alpha.3 or later, the first release with the `internal/config` hook signature it relies on.

Each package now includes its `CHANGELOG.md` in the published npm package.
