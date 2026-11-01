---
"@mzwing/dsh-auto-review": minor
---

init(dsh-auto-review): take over Auto review with Codex Guardian- or Claude Code-style reviews on a model you choose

DeepSeek Harness's built-in Auto review always reviews with the session's own model and takes no config. This plugin provides the same Auto permission mode with a reviewer route you set through `provider`, `model` and `reasoningEffort`, and its bundle patch turns off the built-in row, since only one plugin can provide Auto.

`preset` picks the reviewer, both ported from `@mzwing/pi-permission-auto-review`. `codex`, the default, follows an adaptation of OpenAI Codex's Guardian policy merged with the built-in's rules over a trust-labelled transcript: user prompts, answered questions and a subagent's delegated task can authorize an action, while assistant text, tool results and project instructions cannot. Its denial asks the user, and repeated denials in one turn hand the turn's later calls to the user unreviewed. `claude-code` follows Claude Code's auto mode: a capped fast pass lets clearly safe calls through, and a second pass that reasons first decides the rest, over a transcript of the user's messages and the agent's calls without their output. Its denial goes back to the agent, and only the third in a row or the twentieth in the session asks the user. Under both, a subagent's denied call fails, and a failed review asks the user.

`autoMode` takes Claude Code's `environment`, `allow`, `soft_deny` and `hard_deny` rule lists, where `$defaults` stands for the preset's built-in rules, which `/auto-review defaults` lists. As Codex does, a later call continues the reviewer's conversation with only what the session added since; `followUpReviews` sets when it starts over. Tools in `exemptTools`, read-only ones by default, skip review, every option applies live, and `/auto-review` shows the reviewer in use. When DSH stops or the plugin unloads, Auto sessions move to Workspace Write.
