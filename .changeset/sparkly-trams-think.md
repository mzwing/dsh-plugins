---
"@mzwing/dsh-auto-review": patch
---

fix(dsh-auto-review): stop warning at every start when the built-in Auto review is off

The bundle patch disabled the built-in Auto review's `auto-review` row. That bundle ships switched off, so DSH warned `patch: entry "auto-review" not found` at every start for everyone who never switched it on, and a built-in switched on after this plugin was missed as well, since its row comes later. If you switched the built-in Auto Authorization Review on, switch it off on the Plugins page.
