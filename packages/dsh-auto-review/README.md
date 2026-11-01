# @mzwing/dsh-auto-review

[![npm](https://img.shields.io/npm/v/@mzwing/dsh-auto-review)](https://www.npmjs.com/package/@mzwing/dsh-auto-review)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that takes over the experimental Auto review permission mode, so every tool call is reviewed by a model you choose instead of the session's own. A preset picks the reviewer, both ported from [`@mzwing/pi-permission-auto-review`](https://github.com/mzwing/pi-packages/tree/main/packages/pi-permission-auto-review):

- `codex`, the default: a bundled adaptation of the [OpenAI Codex Guardian policy](https://github.com/openai/codex/tree/main/codex-rs/prompts/templates/guardian), merged with the built-in Auto review's rules.
- `claude-code`: the two-stage check of [Claude Code's auto mode](https://code.claude.com/docs/en/auto-mode-config), with its prompt and rules written anew for DeepSeek Harness.

## Install

```bash
dsh plugin --profile web add @mzwing/dsh-auto-review
```

Only one plugin can provide Auto, so if you switched on the built-in Auto Authorization Review, switch it off on the Plugins page. Restart DSH after installing.

## Usage

Pick Auto review in the permission menu or run `/permission auto`. Before each native tool call and each tool call inside `run_code`, the reviewer reads the conversation and the pending call, and an allowed call runs. Under `codex`, a denied call asks you, with the reviewer's reason. Under `claude-code`, the reason goes back to the agent, and only the third denial in a row or the twentieth in the session asks you. A subagent's denied call fails under either. A failed review, or a `codex` turn with repeated denials, also hands calls to you.

The Web confirmation dialog still says the session's model reviews; `/auto-review` shows the reviewer actually in use and any config problem, and `/auto-review defaults` lists the active preset's built-in rules. When DSH stops or the plugin unloads, Auto sessions move to Workspace Write.

Set the reviewer in `~/.dsh/cordis.patch.yml` or the profile's own `cordis.patch.yml`. Edits apply from the next call on:

```yaml
- id: auto-reviewer
  config:
    provider: my-relay
    model: deepseek-v4.1-flash
```

## Configuration

| Key                 | Default                                          | Description                                                                          |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `preset`            | `codex`                                          | `codex` or `claude-code`                                                             |
| `provider`, `model` | the session's model                              | Reviewer route, set together                                                         |
| `reasoningEffort`   | the model's default, the least for `claude-code` | Reasoning effort for the configured route, used by `claude-code` for its second pass |
| `timeoutMs`         | `90000`                                          | Total budget for one review, retries included                                        |
| `attemptTimeoutMs`  | —                                                | Time limit for one call; without it, only `timeoutMs` applies                        |
| `maxRetries`        | `2`                                              | Retries when a call fails or its reply is malformed                                  |
| `followUpReviews`   | `auto`                                           | Continue the reviewer's conversation across calls; see below                         |
| `autoMode`          | —                                                | Rules beside or instead of the preset's own; see below                               |
| `exemptTools`       | read-only tools                                  | Tools that run unreviewed; a list replaces `defaultExemptTools` whole                |

`autoMode` takes the same four lists as Claude Code's own `autoMode` settings, so rules copied from there paste in. `environment` tells the reviewer what lies inside your trust boundary, `hard_deny` rules always block, and `soft_deny` rules block unless an `allow` exception or the user's explicit consent clears them. Each is a list of prose rules: the entry `$defaults` stands for the preset's built-in rules, and a list without it replaces them. Under `codex`, `$defaults` keeps the Guardian policy's sections where they are, and your other rules join it as operator policy.

```yaml
- id: auto-reviewer
  config:
    preset: claude-code
    autoMode:
      environment:
        - $defaults
        - 'Source control: github.com/acme and every repository under it'
      soft_deny:
        - $defaults
        - Never run database migrations by hand
```

Like Codex, a later call in a session continues the reviewer's conversation and sends only what the session added since the last review. The conversation starts over in full when it would pass 256k tokens or overflow the reviewer's context window, when the reviewer or its rules change, or after a review fails. `auto` also starts over after a follow-up the provider served without a cache hit, so a provider that does not cache never resends a growing conversation; `always` keeps the conversation then, and `off` sends every review in full.

See the [example config](./config/config.example.yml) and `defaultExemptTools` in [`src/config.ts`](./src/config.ts).

The reviewer provider receives capped excerpts of the conversation: tool results included under `codex`, and only whether each call succeeded under `claude-code`. Code inside `run_code` reaches the host directly, so only its tool calls are reviewed.

## License

[MIT](./LICENSE)
