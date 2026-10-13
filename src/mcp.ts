import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CliError } from "./errors.js";
import { Store, DEFAULT_ENDPOINT, validEndpoint } from "./store.js";
import { Provider, envToken, timedFetch } from "./auth.js";
export interface Options {
  profile: string;
  endpoint?: string;
  timeoutMs: number;
}
export class Session {
  constructor(
    public client: Client,
    public timeoutMs: number,
  ) {}
  async tools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: this.timeoutMs },
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor))
          throw new CliError(
            "PAGINATION_ERROR",
            "Server repeated a tools cursor.",
          );
        cursors.add(cursor);
      }
      if (cursors.size >= 1000)
        throw new CliError(
          "PAGINATION_ERROR",
          "Tools discovery exceeded 1000 pages.",
        );
    } while (cursor);
    return tools;
  }
  async call(tool: Tool, args: Record<string, unknown>) {
    const result = await this.client.callTool(
      { name: tool.name, arguments: args },
      undefined,
      { timeout: this.timeoutMs },
    );
    if (result.isError)
      throw new CliError(
        "TOOL_ERROR",
        `Linear tool ${tool.name} failed.`,
        result,
      );
    return result;
  }
}
export async function withSession<T>(
  options: Options,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const store = new Store(options.profile);
  const env = envToken();
  const run = async () => {
    const saved = env ? undefined : await store.read();
    const endpoint = validEndpoint(
      options.endpoint ||
        process.env.LINEAR_MCP_URL ||
        saved?.endpoint ||
        DEFAULT_ENDPOINT,
    );
    if (!env && saved?.endpoint !== endpoint)
      throw new CliError(
        "AUTH_REQUIRED",
        `No OAuth login for this endpoint. Run linear auth login --profile ${options.profile}.`,
      );
    if (!env && !saved?.tokens)
      throw new CliError(
        "AUTH_REQUIRED",
        `Run linear auth login --profile ${options.profile}.`,
      );
    const provider = !env && saved ? new Provider(saved, store) : undefined;
    const fetchFn = timedFetch(options.timeoutMs);
    if (
      provider &&
      saved?.expiresAt &&
      saved.expiresAt <= Date.now() + 60_000
    ) {
      if (!saved.tokens?.refresh_token)
        throw new CliError(
          "AUTH_EXPIRED",
          "Access token expired. Run linear auth login.",
        );
      if (
        (await auth(provider, { serverUrl: endpoint, fetchFn })) !==
        "AUTHORIZED"
      )
        throw new CliError(
          "AUTH_REQUIRED",
          "OAuth session expired. Run linear auth login.",
        );
    }
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      authProvider: provider,
      fetch: fetchFn,
      ...(env
        ? { requestInit: { headers: { Authorization: `Bearer ${env.token}` } } }
        : {}),
    });
    const client = new Client(
      { name: "linear-cli", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, { timeout: options.timeoutMs });
      return await fn(new Session(client, options.timeoutMs));
    } finally {
      await client.close().catch(() => {});
    }
  };
  return env ? run() : store.locked(run, options.timeoutMs);
}
