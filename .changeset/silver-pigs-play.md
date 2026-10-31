---
"@mzwing/dsh-model-info": minor
---

init(dsh-model-info): complete the model metadata of `llm-pi-ai` routes from the pi.dev and models.dev catalogs

A model `llm-pi-ai` has never heard of takes the route's `defaultContextWindow`, `defaultInput` and no reasoning, which throws off compaction timing, admits images a text-only model refuses, and hides the reasoning efforts a model offers. This plugin resolves each opted-in route's model ids against both catalogs and fills their context window, input modalities and reasoning efforts in memory as `llm-pi-ai` resolves its config, so nothing is written to your files. Relay ids carrying routing segments, such as `remote/auto/claude-opus-5-5`, resolve by dropping those segments one at a time.
