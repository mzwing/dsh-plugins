# @mzwing/dsh-model-info

## 0.2.0

### Minor Changes

- [`ad03f46`](https://github.com/mzwing/dsh-plugins/commit/ad03f465d4f724537c905bd5d47ee55d53441ad6) Thanks [@mzwing](https://github.com/mzwing)! - feat(dsh-model-info): expand `*` model entries into the ids the route's endpoint lists
  
  A route pi-ai ships no catalog for serves only the models it writes out, and `llm-pi-ai` lists an endpoint's models only for the Models page to adopt by hand. A `models` entry whose id contains `*` now stands for every id the route's endpoint lists that it matches, so `- id: '*'` serves the whole list with no ids written out. The list comes from `llm-pi-ai`'s own model discovery with the route's API key and headers, is cached, and is fetched again in the background and on `/model-info refresh`. Until it arrives the pattern entry is served as written, which `llm-pi-ai` accepts as an ordinary id.
  
  Keys under a route's `models` in model-info's own config take `*` as well, so one `alias`, `override`, `skip` or affix gate covers a model under every routing prefix a relay serves it with. An exact key still wins, then the longest matching pattern, so overlapping patterns rank by how specific they are rather than by key order.

## 0.1.1

### Patch Changes

- [`ab290ce`](https://github.com/mzwing/dsh-plugins/commit/ab290ceb73490c59b43e2838b9f1bbad4aaab43c) Thanks [@mzwing](https://github.com/mzwing)! - chore(dsh-model-info): update a patch version to setup npm trusted publisher connection

## 0.1.0

### Minor Changes

- [`c51af28`](https://github.com/mzwing/dsh-plugins/commit/c51af2846e00f4615ed65f953d095e53e0a3bcb7) Thanks [@mzwing](https://github.com/mzwing)! - init(dsh-model-info): complete the model metadata of `llm-pi-ai` routes from the pi.dev and models.dev catalogs
  
  A model `llm-pi-ai` has never heard of takes the route's `defaultContextWindow`, `defaultInput` and no reasoning, which throws off compaction timing, admits images a text-only model refuses, and hides the reasoning efforts a model offers. This plugin resolves each opted-in route's model ids against both catalogs and fills their context window, input modalities and reasoning efforts in memory as `llm-pi-ai` resolves its config, so nothing is written to your files. Relay ids carrying routing segments, such as `remote/auto/claude-opus-5-5`, resolve by dropping those segments one at a time.
