#!/usr/bin/env node
import { Command } from "commander";
import { Store, DEFAULT_ENDPOINT, validEndpoint } from "./store.js";
import { login, status, timedFetch, envToken } from "./auth.js";
import { withSession, type Options } from "./mcp.js";
import { argumentsFor, resolveTool, nouns } from "./arguments.js";
import { CliError, errorInfo, redact } from "./errors.js";
const jsonRequested = process.argv.includes("--json");
const program = new Command()
  .name("linear")
  .description(
    "All official Linear MCP tools with one shared OAuth login.\nSchema fields accept --kebab-case or --camelCase flags; objects/arrays use JSON.",
  )
  .version("0.1.0")
  .option("--json", "emit a stable JSON success/error envelope")
  .option(
    "--profile <name>",
    "isolated workspace/OAuth profile",
    process.env.LINEAR_PROFILE || "default",
  )
  .option(
    "--endpoint <url>",
    "MCP endpoint override (HTTPS or local test server)",
  )
  .option("--timeout <seconds>", "request timeout in seconds", "30")
  .showHelpAfterError();
program.configureOutput({
  writeErr: (text) => {
    if (!jsonRequested) process.stderr.write(text);
  },
  outputError: (text) => {
    if (!jsonRequested) process.stderr.write(text);
  },
});
program.exitOverride();
function options(command: Command): Options {
  const opts = command.optsWithGlobals();
  const seconds = Number(opts.timeout);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600)
    throw new CliError(
      "INVALID_TIMEOUT",
      "Timeout must be between 1 and 600 seconds.",
    );
  return {
    profile: opts.profile,
    endpoint: opts.endpoint ? validEndpoint(opts.endpoint) : undefined,
    timeoutMs: seconds * 1000,
  };
}
function output(data: unknown, command?: Command) {
  const json = command?.optsWithGlobals().json || jsonRequested;
  process.stdout.write(
    JSON.stringify(redact(json ? { ok: true, data } : data), null, 2) + "\n",
  );
}
function dynamic(command: Command) {
  return command
    .argument("[args...]")
    .allowUnknownOption()
    .allowExcessArguments()
    .addHelpText(
      "after",
      '\nInputs: --data \'{"field":"value"}\', --data-file path.json, --data - (stdin).\nUse --dry-run to validate and preview without calling the tool.\nRun linear tools show TOOL for descriptions, instructions and the full schema.',
    );
}
async function invoke(
  name: string | undefined,
  tokens: string[],
  command: Command,
  noun?: string,
  verb?: string,
) {
  return withSession(options(command), async (session) => {
    const tools = await session.tools();
    const tool =
      noun && verb
        ? resolveTool(tools, noun, verb)
        : tools.find((tool) => tool.name === name);
    if (!tool)
      throw new CliError(
        "UNKNOWN_TOOL",
        `No tool named ${name}; run linear tools list.`,
      );
    const { args, dryRun } = await argumentsFor(tool, tokens, !!noun);
    if (
      noun &&
      tool.name.startsWith("save_") &&
      tool.inputSchema.properties &&
      "id" in tool.inputSchema.properties
    ) {
      if (verb === "update" && (typeof args.id !== "string" || !args.id.trim()))
        throw new CliError(
          "INVALID_ARGUMENT",
          `${noun} update requires --id to identify the existing object.`,
        );
      if (verb === "create" && args.id !== undefined)
        throw new CliError(
          "INVALID_ARGUMENT",
          `${noun} create cannot include --id; use update for an existing object.`,
        );
    }
    if (dryRun)
      return {
        dryRun: true,
        tool: tool.name,
        arguments: args,
        annotations: tool.annotations,
      };
    return { tool: tool.name, result: await session.call(tool, args) };
  });
}
const authCommand = program
  .command("auth")
  .description("Shared OAuth login, session status and local logout");
authCommand
  .command("login")
  .description("Authorize via browser and a loopback PKCE callback")
  .option("--no-browser", "print login URL without opening a browser")
  .option("--scope <scopes>", "requested OAuth scopes", "read write")
  .option("--login-timeout <seconds>", "time allowed to authorize", "300")
  .option(
    "--port <number>",
    "fixed loopback callback port (default: random available port)",
  )
  .action(async (_opts, command: Command) => {
    const opts = command.optsWithGlobals();
    const setup = options(command);
    const seconds = Number(opts.loginTimeout);
    const port = opts.port ? Number(opts.port) : undefined;
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600)
      throw new CliError(
        "INVALID_TIMEOUT",
        "Login timeout must be 1–3600 seconds.",
      );
    if (
      port !== undefined &&
      (!Number.isInteger(port) || port < 1024 || port > 65535)
    )
      throw new CliError(
        "INVALID_PORT",
        "Port must be an integer from 1024 to 65535.",
      );
    const store = new Store(setup.profile);
    const saved = await store.read();
    output(
      await login(
        store,
        validEndpoint(
          setup.endpoint ||
            process.env.LINEAR_MCP_URL ||
            saved?.endpoint ||
            DEFAULT_ENDPOINT,
        ),
        {
          noBrowser: !opts.browser,
          timeoutMs: seconds * 1000,
          scope: opts.scope,
          port,
        },
      ),
      command,
    );
  });
authCommand
  .command("status")
  .description("Report auth source and expiry without printing tokens")
  .action(async (_opts, command: Command) => {
    const opts = options(command);
    output(
      await status(
        new Store(opts.profile),
        opts.endpoint || process.env.LINEAR_MCP_URL,
      ),
      command,
    );
  });
authCommand
  .command("logout")
  .description("Delete this profile’s locally stored OAuth credentials")
  .action(async (_opts, command: Command) => {
    const opts = options(command);
    const store = new Store(opts.profile);
    await store.locked(() => store.remove());
    output(
      {
        profile: opts.profile,
        loggedOut: true,
        note: "Local credentials deleted; environment tokens and server grants are unchanged.",
      },
      command,
    );
  });
program
  .command("profiles")
  .description("Workspace profiles (choose using --profile)")
  .command("list")
  .action(async (_opts, command: Command) => {
    output(
      {
        profiles: await new Store().profiles(),
        selected: options(command).profile,
      },
      command,
    );
  });
program
  .command("doctor")
  .description("Inspect config, auth and hosted endpoint; works without login")
  .option("--offline", "skip endpoint reachability checks")
  .action(async (_opts, command: Command) => {
    const opts = options(command);
    const store = new Store(opts.profile);
    const saved = envToken() ? undefined : await store.read();
    const endpoint = validEndpoint(
      opts.endpoint ||
        process.env.LINEAR_MCP_URL ||
        saved?.endpoint ||
        DEFAULT_ENDPOINT,
    );
    const authStatus = await status(store, endpoint);
    let reachability: Record<string, unknown> = { checked: false };
    if (!command.opts().offline) {
      try {
        const response = await timedFetch(opts.timeoutMs)(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "linear-cli-doctor", version: "0.1.0" },
            },
          }),
        });
        reachability = {
          checked: true,
          reachable: [200, 202, 401, 403].includes(response.status),
          httpStatus: response.status,
        };
        await response.body?.cancel();
      } catch (error) {
        reachability = {
          checked: true,
          reachable: false,
          error: errorInfo(error),
        };
      }
    }
    output(
      {
        version: "0.1.0",
        node: process.version,
        configDirectory: store.dir,
        ...authStatus,
        endpoint,
        reachability,
        nextStep: authStatus.authenticated
          ? "linear tools list --json"
          : `linear auth login --profile ${opts.profile}`,
      },
      command,
    );
  });
const tools = program
  .command("tools")
  .description(
    "Live tool discovery, complete schemas/instructions and raw calls",
  );
tools
  .command("list")
  .description("List every hosted tool, following all catalog pages")
  .option(
    "--full",
    "include complete descriptions, procedural instructions and schemas",
  )
  .action(async (_opts, command: Command) => {
    output(
      await withSession(options(command), async (session) => {
        const catalog = await session.tools();
        return {
          tools: command.opts().full
            ? catalog
            : catalog.map((tool) => ({
                name: tool.name,
                description: (tool.description || "")
                  .split("\n")[0]
                  .slice(0, 240),
                annotations: tool.annotations,
              })),
        };
      }),
      command,
    );
  });
tools
  .command("show")
  .argument("<name>")
  .description(
    "Show the full tool description, procedural instructions and input schema",
  )
  .action(async (name, _opts, command: Command) => {
    output(
      await withSession(options(command), async (session) => {
        const tool = (await session.tools()).find((tool) => tool.name === name);
        if (!tool) throw new CliError("UNKNOWN_TOOL", `No tool named ${name}.`);
        return tool;
      }),
      command,
    );
  });
dynamic(
  tools
    .command("call")
    .argument("<name>")
    .description("Call any current or newly added MCP tool"),
).action(async (name: string, args: string[], _opts, command: Command) =>
  output(await invoke(name, args, command), command),
);
dynamic(
  program
    .command("tool")
    .argument("<name>")
    .description("Call an exact MCP tool name (same as tools call)"),
).action(async (name: string, args: string[], _opts, command: Command) =>
  output(await invoke(name, args, command), command),
);
for (const noun of nouns) {
  const group = program
    .command(noun)
    .description(`Read and write ${noun} using the current Linear tool schema`);
  for (const verb of ["list", "get", "resolve", "create", "update", "delete"]) {
    dynamic(
      group
        .command(verb)
        .description(
          `${verb} ${noun}; availability and fields come from the hosted catalog`,
        ),
    ).action(async (args: string[], _opts, command: Command) =>
      output(await invoke(undefined, args, command, noun, verb), command),
    );
  }
}
program.addHelpText(
  "after",
  "\nExamples:\n  linear auth login\n  linear --json issues list --limit 20 --assignee me\n  linear --json issues get ENG-123\n  linear tools show save_issue\n  linear --json issues create --data-file issue.json --dry-run\n  linear --json tools call save_issue --data -\n\nAuthentication: LINEAR_API_KEY, then LINEAR_ACCESS_TOKEN, then selected OAuth profile.\nNo browser is opened by ordinary commands. All current hosted tools are callable.",
);
try {
  await program.parseAsync();
} catch (error) {
  const code = (error as { code?: string }).code;
  if (code === "commander.helpDisplayed" || code === "commander.version")
    process.exitCode = 0;
  else {
    process.exitCode = 1;
    const info = errorInfo(
      code?.startsWith("commander.")
        ? new CliError("INVALID_ARGUMENT", (error as Error).message)
        : error,
    );
    if (jsonRequested)
      process.stdout.write(JSON.stringify({ ok: false, error: info }) + "\n");
    else process.stderr.write(JSON.stringify(info, null, 2) + "\n");
  }
}
