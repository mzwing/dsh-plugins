# @mzwing/dsh-model-info

[![npm](https://img.shields.io/npm/v/@mzwing/dsh-model-info)](https://www.npmjs.com/package/@mzwing/dsh-model-info)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lists the models of your `llm-pi-ai` routes from their endpoints and completes their context window, input modalities and reasoning efforts from the [pi.dev](https://pi.dev/api/models) and [models.dev](https://models.dev) catalogs, where DSH would otherwise fall back to the route's defaults. It fills the model entries in memory each time `llm-pi-ai` resolves its config, so nothing is written to your files.

## Install

```bash
dsh plugin --profile web add @mzwing/dsh-model-info
```

## Usage

Nothing happens until a route is opted in, in `~/.dsh/cordis.patch.yml` or the profile's own `cordis.patch.yml`:

```yaml
- id: model-info
  config:
    providers:
      my-relay: {}
```

Only routes that list their `models` are completed. A model is matched by its alias, then its exact id, then its id with leading `/` segments dropped one at a time, then its id with at most one prefix and one suffix rule removed. An ambiguous match changes nothing, and fields you wrote on a model entry always win. `maxTokens` is never taken from a catalog, because `llm-pi-ai` reserves a configured `maxTokens` on every request.

A `models` entry whose id contains `*` stands for every id the route's endpoint lists that it matches, with `*` matching any run of characters, so this route serves the endpoint's whole list:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-relay:
        models:
          - id: '*'
```

Each model a pattern brings in carries the fields written on the pattern, and entries you write out keep their place and fields. The list comes from `llm-pi-ai`'s own model discovery, so the route's API key and headers apply, and it is cached and fetched again in the background. Until the first list arrives, `llm-pi-ai` serves the pattern entry as written.

`/model-info` summarises what was listed and completed, `/model-info <route>/<model>` shows where each field came from, and `/model-info refresh` re-checks the catalogs and the endpoints.

## Configuration

Per route, under `providers`:

| Key                   | Default   | Description                                                                   |
| --------------------- | --------- | ----------------------------------------------------------------------------- |
| `catalogProvider`     | —         | Scope lookups to one catalog provider, e.g. `openrouter`                      |
| `contextWindowPolicy` | `catalog` | `min` never raises the route's `defaultContextWindow`, `keep` leaves it alone |
| `capabilityPolicy`    | `catalog` | `widen` only adds capabilities, `keep` leaves them alone                      |
| `useCatalogName`      | `false`   | Rename models to their catalog names                                          |
| `mapThinkingLevels`   | `false`   | Derive reasoning efforts from models.dev                                      |
| `models`              | —         | Per-model `alias`, `override`, `skip`, `prefixes` and `suffixes`              |

An `override` takes the same fields as an `llm-pi-ai` model entry: `name`, `contextWindow`, `maxTokens`, `input` and `reasoningEfforts`. A `models` key containing `*` covers every model it matches, so one entry reaches a model under all of a relay's routing prefixes; an exact key wins, then the longest matching pattern.

Rules strip an affix before matching. `-free` and `:free` are built in:

```yaml
rules:
  - id: thinking
    kind: suffix
    value: -thinking
    override:
      contextWindow: 250000
```

See the [example config](./config/config.example.yml) and [`src/config.ts`](./src/config.ts) for every option.

## License

[MIT](./LICENSE)
