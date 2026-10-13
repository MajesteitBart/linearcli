---
name: linear-cli
description: Use the installed linear terminal CLI to read and manage Linear issues, projects, teams and other resources through a shared OAuth login. Prefer this CLI for Linear work from coding agents when it is available.
---

Use `command -v linear`, then `linear --json doctor` to check setup. If missing, installation instructions live at `/home/bartadmin/Development/linear-cli/README.md`.

Authentication is shared across terminal agents. `linear auth login` opens browser consent; user interaction is needed only for login. Ordinary commands must not initiate login. `LINEAR_API_KEY` or `LINEAR_ACCESS_TOKEN` overrides saved OAuth credentials. Use `--profile NAME` for a separately authenticated workspace.

Discover IDs with `linear --json teams list`, `linear --json projects list` and `linear --json users list`. Use a known issue identifier directly with `linear --json issues get --id ENG-123`. Inspect the command's help and the matching live tool before assuming filters or write fields.

`linear --json tools list` lists every tool exposed by Linear. `linear --json tools show TOOL_NAME` returns its full instructions and input schema. Read those instructions, including any upload or attachment procedure, before using unfamiliar tools. The catalog is live and may change.

Prefer noun commands for common jobs. `linear tools call TOOL_NAME --data-file input.json` is the complete escape hatch. `--data -` reads JSON from stdin; `--data '{"key":"value"}'` accepts an inline JSON object. Schema field names become kebab-case flags, including numeric, boolean, object and array fields.

For a write, inspect the tool schema, prepare exact inputs, then run with `--dry-run`. This validates the call without executing the tool. Execute the same call without `--dry-run` when the requested change is authorized. Do not infer authorization to create, update or delete unrelated Linear data.

Use `--json` when processing output. Success is `{"ok":true,"data":...}`; errors are `{"ok":false,"error":{"code":"...","message":"..."}}` with a nonzero exit. A tool call retains MCP content and structured content inside `data`; parse returned text blocks as JSON only when they contain JSON. Preserve the server's pagination cursor and use the limit/cursor fields documented in its tool schema.

Examples:

```bash
linear --json doctor
linear --json issues list --team ENG --limit 20
linear --json tools call save_issue --data-file issue.json --dry-run
```

If a tool name in an example is unavailable, select its equivalent from `tools list`; never assume a fixed tool inventory.
