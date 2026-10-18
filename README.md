# brief-template

A Claude Code mod that lets an `Agent` call name a markdown brief instead of spelling it out. When several subagents share most of a brief, write it once with `{{name}}` tags and pass this JSON as the whole prompt:

```json
{"$brief": "review-brief.md", "vars": {"crate": "parser", "focus": "error recovery"}}
```

The file is read, each `{{name}}` (or `{{ name }}`) is replaced by `vars.name`, and the result becomes the agent's prompt. A workflow script's `agent()` prompt takes the same request.

- Tag names use letters, digits, `_`, `.` and `-`. `\{{` writes a literal `{{`.
- A relative `$brief` path resolves against the session's working directory, not the agent's.
- The call is denied, with the reason, when the file can't be read, a tag has no value (the deny names each tag and its line), a var isn't a string, a `vars` key isn't a tag name, or the object has a key other than `$brief` and `vars`. Vars that match no tag are ignored.
- A JSON prompt with no `$brief` key passes through untouched.
- The mod appends this usage to the `Agent` tool's description, so the model knows the request form.

## Install

From the [davesmods](https://github.com/davethedev3/davesmods) marketplace:

```sh
claude plugin marketplace add davethedev3/davesmods
claude plugin install brief-template@davesmods
```

Function-hooks mods are an early-access Claude Code feature (written against 2.1.302). To run from a checkout instead, load the folder with `claude --plugin-dir /path/to/brief-template`, or list it in `CLAUDE_CODE_PLUGIN_DIRS` (colon-separated) to load it in every session. The engine writes the plugin API's type declarations to `.claude-plugin/types/` when it loads the mod; they are not part of this repo.

Checks: `claude plugin validate .` and `claude plugin test .` from this folder.
