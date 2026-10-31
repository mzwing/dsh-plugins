# @mzwing/dsh-model-info

## 0.1.1

### Patch Changes

- [`ab290ce`](https://github.com/mzwing/dsh-plugins/commit/ab290ceb73490c59b43e2838b9f1bbad4aaab43c) Thanks [@mzwing](https://github.com/mzwing)! - chore(dsh-model-info): update a patch version to setup npm trusted publisher connection

## 0.1.0

### Minor Changes

- [`c51af28`](https://github.com/mzwing/dsh-plugins/commit/c51af2846e00f4615ed65f953d095e53e0a3bcb7) Thanks [@mzwing](https://github.com/mzwing)! - init(dsh-model-info): complete the model metadata of `llm-pi-ai` routes from the pi.dev and models.dev catalogs
  
  A model `llm-pi-ai` has never heard of takes the route's `defaultContextWindow`, `defaultInput` and no reasoning, which throws off compaction timing, admits images a text-only model refuses, and hides the reasoning efforts a model offers. This plugin resolves each opted-in route's model ids against both catalogs and fills their context window, input modalities and reasoning efforts in memory as `llm-pi-ai` resolves its config, so nothing is written to your files. Relay ids carrying routing segments, such as `remote/auto/claude-opus-5-5`, resolve by dropping those segments one at a time.
