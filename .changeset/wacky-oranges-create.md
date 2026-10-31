---
"@mzwing/dsh-model-info": minor
---

feat(dsh-model-info): expand `*` model entries into the ids the route's endpoint lists

A route pi-ai ships no catalog for serves only the models it writes out, and `llm-pi-ai` lists an endpoint's models only for the Models page to adopt by hand. A `models` entry whose id contains `*` now stands for every id the route's endpoint lists that it matches, so `- id: '*'` serves the whole list with no ids written out. The list comes from `llm-pi-ai`'s own model discovery with the route's API key and headers, is cached, and is fetched again in the background and on `/model-info refresh`. Until it arrives the pattern entry is served as written, which `llm-pi-ai` accepts as an ordinary id.

Keys under a route's `models` in model-info's own config take `*` as well, so one `alias`, `override`, `skip` or affix gate covers a model under every routing prefix a relay serves it with. An exact key still wins, then the longest matching pattern, so overlapping patterns rank by how specific they are rather than by key order.
