# @mzwing/dsh-auto-review

## 0.1.3

### Patch Changes

- [`03b9d93`](https://github.com/mzwing/dsh-plugins/commit/03b9d93d6759a16fded29f7e68f2328c6cafdeec) Thanks [@mzwing](https://github.com/mzwing)! - fix(dsh-auto-review): never resend a request the provider refused
  
  A review retried every failure outside a short list DSH names as permanent. A request Claude refused, which the pi-ai adapter reports under its catch-all `PI_AI_ERROR`, therefore went out again up to `maxRetries` times, each time drawing another refusal on the account. A failed call is now retried only for the codes DSH's own retries resend by default: `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` and `TRANSPORT`. A refusal, or any other failure a retry cannot change, falls to you at once.

- [`ae68470`](https://github.com/mzwing/dsh-plugins/commit/ae68470ce3eed4867ceca62979b370f17217fe50) Thanks [@mzwing](https://github.com/mzwing)! - fix(dsh-auto-review): stop Claude from refusing the `claude-code` second pass
  
  The second pass asked the reviewer to write its reasoning in `<thinking>` tags in its reply. Claude Sonnet 5.5 and other recent Claude models refuse that as reasoning extraction before answering, so no call the fast pass flagged got a verdict, and each fell to you once the review failed.
  
  The second pass now reasons natively, at `reasoningEffort` when it is set and at the model's default otherwise, where it used the least effort before. The policy revision becomes `claude-code/2.1.314+dsh2`.

## 0.1.2

### Patch Changes

- [`2f3cc8b`](https://github.com/mzwing/dsh-plugins/commit/2f3cc8b84f63fb3cc05e69c59d0581889310c70a) Thanks [@mzwing](https://github.com/mzwing)! - fix(dsh-auto-review): stop warning at every start when the built-in Auto review is off
  
  The bundle patch disabled the built-in Auto review's `auto-review` row. That bundle ships switched off, so DSH warned `patch: entry "auto-review" not found` at every start for everyone who never switched it on, and a built-in switched on after this plugin was missed as well, since its row comes later. If you switched the built-in Auto Authorization Review on, switch it off on the Plugins page.

## 0.1.1

### Patch Changes

- [`d0d895c`](https://github.com/mzwing/dsh-plugins/commit/d0d895c15c78a6263c0b3435bb4543cd9d43b39a) Thanks [@mzwing](https://github.com/mzwing)! - chore(dsh-auto-review): setup npm trusted publisher connection

## 0.1.0

### Minor Changes

- [`c57b4ab`](https://github.com/mzwing/dsh-plugins/commit/c57b4ab39c72e3cd3e01eda8d88177ea6f223fe5) Thanks [@mzwing](https://github.com/mzwing)! - init(dsh-auto-review): take over Auto review with Codex Guardian- or Claude Code-style reviews on a model you choose
  
  DeepSeek Harness's built-in Auto review always reviews with the session's own model and takes no config. This plugin provides the same Auto permission mode with a reviewer route you set through `provider`, `model` and `reasoningEffort`, and its bundle patch turns off the built-in row, since only one plugin can provide Auto.
  
  `preset` picks the reviewer, both ported from `@mzwing/pi-permission-auto-review`. `codex`, the default, follows an adaptation of OpenAI Codex's Guardian policy merged with the built-in's rules over a trust-labelled transcript: user prompts, answered questions and a subagent's delegated task can authorize an action, while assistant text, tool results and project instructions cannot. Its denial asks the user, and repeated denials in one turn hand the turn's later calls to the user unreviewed. `claude-code` follows Claude Code's auto mode: a capped fast pass lets clearly safe calls through, and a second pass that reasons first decides the rest, over a transcript of the user's messages and the agent's calls without their output. Its denial goes back to the agent, and only the third in a row or the twentieth in the session asks the user. Under both, a subagent's denied call fails, and a failed review asks the user.
  
  `autoMode` takes Claude Code's `environment`, `allow`, `soft_deny` and `hard_deny` rule lists, where `$defaults` stands for the preset's built-in rules, which `/auto-review defaults` lists. As Codex does, a later call continues the reviewer's conversation with only what the session added since; `followUpReviews` sets when it starts over. Tools in `exemptTools`, read-only ones by default, skip review, every option applies live, and `/auto-review` shows the reviewer in use. When DSH stops or the plugin unloads, Auto sessions move to Workspace Write.
