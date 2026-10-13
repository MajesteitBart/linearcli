# Linear CLI

One terminal command for every tool in Linear’s official hosted MCP server, with an OAuth login shared by your coding CLIs on the same machine. Node.js 22 or newer is required.

The CLI calls `https://mcp.linear.app/mcp` internally. It discovers the tool catalog every time rather than maintaining a separate GraphQL implementation. When Linear adds a tool or changes its input schema, `tools call` can use it immediately. Availability, workspace permissions, rate limits and tool behavior come from Linear’s hosted server. Offline commands include help, version, local auth status, profile listing, logout and `doctor --offline`.

## Install

From this repository:

```bash
npm ci
npm run build
npm run install-local
```

This installs `linear` and `linear-cli` launchers in `~/.local/bin` pointing to this checkout. Keep the checkout and its `node_modules`, and put `~/.local/bin` on your PATH. To update, update this checkout, run `npm ci` and `npm run build`. Alternatively, `npm link` installs the package’s standard Node executables. This package has not been published to npm.

Check from any directory:

```bash
linear --help
linear --json doctor
```

## Authenticate once

```bash
linear auth login
linear --json auth status
linear --json teams list
```

Login discovers Linear’s authorization server, dynamically registers a public OAuth client, requests `read write`, and uses PKCE with an unpredictable validated state and a callback bound to `127.0.0.1`. It prints the authorization link to stderr and opens your browser. Ordinary commands never open a browser for interactive login; they tell you to run `auth login` if authorization is needed.

```bash
linear auth login --no-browser           # open the printed URL yourself on this machine
linear auth login --scope read           # request a read-only grant
linear auth login --login-timeout 600    # wait up to ten minutes
linear auth login --port 53682           # optional fixed callback port
linear auth logout                      # delete this profile's local credentials
```

`--no-browser` still requires a browser on a machine able to reach the callback. On a remote host, forward the fixed callback port before opening the link. Logout removes local credentials; it does not revoke the server’s grant or remove tokens from your environment. Revoke an unwanted grant in Linear’s authorized applications settings.

Authentication precedence:

1. `LINEAR_API_KEY` — an existing Linear API key, sent as a bearer token.
2. `LINEAR_ACCESS_TOKEN` — an existing bearer access token.
3. Saved OAuth credentials for the selected profile.

Environment tokens bypass stored OAuth credentials and are never persisted. They cannot be refreshed by the CLI. OAuth access tokens refresh automatically, including when the server returns an authorization challenge. Expiring tokens refresh before a call. Calls using a saved profile are serialized by a process lock so concurrent coding CLIs do not rotate the same refresh token simultaneously. A busy profile returns an actionable error after `--timeout`; retry when the active command finishes. A crashed process’s lock is recovered when its PID no longer exists.

## Workspaces and configuration

Use one profile per Linear workspace or authorization grant:

```bash
linear --profile work auth login
linear --profile personal auth login --scope read
linear --json profiles list
linear --profile work --json projects list --limit 20
```

`LINEAR_PROFILE` supplies the default profile name (`default` otherwise). The OAuth authorization screen controls which workspace the grant accesses; the profile name is a local label, not a workspace switch on the server.

Credentials, registered client information and discovery metadata live in:

- `$LINEAR_CONFIG_DIR/<profile>.json` when set;
- otherwise `$XDG_CONFIG_HOME/linear-cli/<profile>.json`;
- otherwise `~/.config/linear-cli/<profile>.json`.

Credentials are local plaintext. On Unix, the directory uses `0700` permissions and files use `0600`. On Windows, the CLI uses Windows PowerShell to restrict and check ACLs, allowing only your account, SYSTEM and Administrators. New credential files receive restricted ACLs before the atomic rename. Symlink credential files and files owned by another user are rejected. OAuth state and PKCE verifiers remain in memory during login. Tokens and client secrets are redacted from CLI output and errors. Treat the configuration directory as sensitive and keep it out of Git and shared folders.

`LINEAR_MCP_URL` or `--endpoint` overrides the endpoint. HTTPS is required except for localhost test servers. Saved OAuth credentials are bound to their endpoint and authorization server. Environment credentials use the explicitly selected endpoint or the official default; do not point them at a server you do not trust. `--timeout` controls network/MCP request timeouts (default 30 seconds, maximum 600).

## Discover tools and follow their instructions

```bash
linear --json tools list                 # concise names/descriptions from every catalog page
linear --json tools list --full          # all full descriptions, instructions and schemas
linear --json tools show save_issue      # authoritative procedure and fields for one tool
```

Read a tool’s full description before using it. Linear sometimes includes procedural requirements in the description, such as discovering teams or labels first. `tools show` and `tools list --full` preserve these descriptions, input/output schemas, annotations and other server fields. The CLI validates arguments against the current input schema; it does not reinterpret the tool’s workflow instructions.

## Product commands

```bash
linear --json issues list --limit 20 --assignee me
linear --json issues get ENG-123
linear --json issues resolve ENG-123
linear --json teams list
linear --json projects list --limit 20
linear --json users get --id me
linear --json comments list --issue-id ENG-123
linear --json documents get --id DOCUMENT_ID
```

Available noun groups: issues, projects, teams, users, comments, documents, cycles, labels, statuses, initiatives, milestones, project-updates, initiative-updates, attachments and project-labels. Each exposes `list`, `get`, `resolve`, `create`, `update`, `delete`. A command is usable only when the hosted server exposes a corresponding tool. Unsupported actions return `UNSUPPORTED_COMMAND`; they do not pretend to exist. `create` and `update` fall back to a shared `save_*` tool when that is what Linear exposes. If that tool has an `id` field, `update` requires a nonempty `--id` and `create` rejects `--id`, preserving the action you requested.

`resolve` uses the corresponding `get_*` tool, accepting the identifiers that tool supports. For example, `issues resolve ENG-123` delegates identifier resolution to Linear. It does not perform fuzzy name searches. Prefer explicit flags for tools without an `id` field.

All flags come from the tool’s current input schema: `--include-archived` and `--includeArchived` address `includeArchived`; boolean fields accept `true`, `false`, or a flag alone for true; number fields become JSON numbers. Objects and arrays accept JSON. Repeated array flags concatenate:

```bash
linear --json issues list --include-archived false --labels '["bug","urgent"]'
linear --json issues list --labels bug --labels urgent
```

These examples depend on the current server accepting those fields. Use `tools show TOOL` for the exact schema. List aliases default to 50 when a `limit` field exists, clamped to the schema’s limits/default. Explicit limits follow the schema’s bounds or 1–250 if the schema supplies no bounds. The raw tool interface applies only the server’s schema and supplies no default limit. Pagination cursors and provider result fields are returned unchanged; pass a returned cursor to the next call. The CLI never silently fetches all your issues/projects.

## Writes and dry runs

```bash
linear --json issues create --title "Investigate timeout" --team TEAM_ID --dry-run
linear --json issues create --data-file issue.json --dry-run
linear --json issues create --data-file issue.json
linear --json issues update --data '{"id":"ENG-123","title":"Investigate refresh timeout"}' --dry-run
```

Every tool call accepts `--dry-run`, including aliases and raw commands. It discovers the live tool schema and validates the arguments, then returns `{dryRun:true,tool,arguments,annotations}` without issuing `tools/call`. Dry runs still require auth and a network connection for discovery. A tool’s schema may permit both create and update in one `save_*` action; supply the IDs and other required fields according to `tools show`.

Live write commands execute the requested tool once. They do not retry a failed write automatically at the CLI level. The MCP transport may refresh authentication and retry an authorization challenge according to the official SDK.

## Complete tool escape hatch

```bash
linear --json tools call get_issue --data '{"id":"ENG-123"}'
linear --json tools call save_issue --data-file issue.json --dry-run
printf '%s' '{"id":"ENG-123"}' | linear --json tool get_issue --data -
linear --json tool NEW_TOOL --field value
```

`tool NAME` and `tools call NAME` are equivalent. They work for any current or newly introduced tool, even if no noun alias exists. `--data` accepts a JSON object, `--data-file` reads one from a file, and `--data -` / `--data-file -` reads stdin (up to 10 MB). Nested object/array fields remain intact. Arguments from schema flags can extend or override an earlier JSON object. Use `--field=value` for a string beginning with `--`. Top-level MCP tool arguments must be an object; arrays belong inside its fields.

## JSON and exits

`--json` works before or after subcommands. Stdout contains one JSON object. Diagnostics and the login URL go to stderr. Help and version are plain text even with `--json`.

```json
{
  "ok": true,
  "data": {
    "tool": "get_issue",
    "result": { "content": [{ "type": "text", "text": "..." }] }
  }
}
```

A raw/alias call returns `data.tool` and the full MCP `data.result`, including text/image/resource content, structured content and pagination fields. `tools list` returns `data.tools`; `tools show` returns the tool definition directly. Auth, profiles, dry-run and doctor commands return their named fields inside `data`. Human mode displays the same data as indented JSON without the envelope, making nested MCP content inspectable without guessing its structure.

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Run linear auth login --profile default."
  }
}
```

Errors may include `error.details` for schema validation or a failed MCP result. Invalid arguments, auth failures, transport failures and `isError` tool results exit nonzero. Successful empty results exit zero. `doctor` exits zero when it reports missing auth or an unreachable endpoint; inspect `data.authenticated` and `data.reachability` to decide what to do.

## Coding-agent skill

The included [companion skill](skills/linear-cli/SKILL.md) teaches discovery, shared authentication, reads and dry-run writes. It is installed for Codex on this machine under `~/.codex/skills/linear-cli`. To use it elsewhere, copy the skill folder into your coding agent's skill directory and update its installation reference if necessary. Every agent that can run shell commands can use the CLI without an MCP configuration.

`auth status` reports credential presence and expiry. `doctor` adds an unauthenticated endpoint reachability check; it does not verify that a stored token still has workspace access. An authenticated read such as `teams list` verifies that access.

## Develop and verify

```bash
npm run format:check
npm run typecheck
npm run build
npm test
```

Tests use a local HTTP MCP/OAuth fixture through the official client SDK. They cover paginated discovery, dynamic arguments, stdin, dry-run prevention, JSON output/exit codes, PKCE and dynamic registration, state rejection, login timeout, secure persistence, isolated profiles and concurrent refresh. They never mutate Linear data. A real Linear OAuth login and authenticated workspace read require your own grant; local tests do not establish production workspace access.

Sources: [Linear MCP documentation](https://linear.app/docs/mcp), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
