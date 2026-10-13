import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
export const catalog: Tool[] = [
  {
    name: "list_issues",
    description: "List issues. First discover the team before querying.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer" },
        cursor: { type: "string" },
        includeArchived: { type: "boolean" },
        priority: { type: "number" },
        labels: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "get_issue",
    description: "Fetch an identifier or ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "save_issue",
    description: "Create or update an issue. Read team fields first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        team: { type: "string" },
        metadata: { type: "object" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "future_tool",
    description: "A newly added tool.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
    },
  },
  {
    name: "fail_tool",
    description: "Tool failure.",
    inputSchema: { type: "object", properties: {} },
  },
];
export async function fixture() {
  let origin = "";
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const requests: string[] = [];
  let challenge = "";
  let redirectUri = "";
  let refreshes = 0;
  const server = createServer(async (req, res) => {
    try {
      requests.push(`${req.method} ${req.url}`);
      const path = new URL(req.url || "/", origin).pathname;
      const send = (data: unknown, status = 200) => {
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(data));
      };
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return send({
          resource: origin,
          authorization_servers: [origin],
          scopes_supported: ["read", "write"],
        });
      if (
        path.startsWith("/.well-known/oauth-authorization-server") ||
        path.startsWith("/.well-known/openid-configuration")
      )
        return send({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          registration_endpoint: origin + "/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      let body = "";
      for await (const chunk of req) body += chunk;
      if (path === "/register") {
        const metadata = JSON.parse(body);
        redirectUri = metadata.redirect_uris[0];
        return send({ ...metadata, client_id: "test-client" });
      }
      if (path === "/token") {
        const params = new URLSearchParams(body);
        if (params.get("grant_type") === "refresh_token") {
          refreshes++;
          if (params.get("refresh_token") !== "test-refresh")
            return send({ error: "invalid_grant" }, 400);
          return send({
            access_token: "test-access",
            refresh_token: "test-refresh",
            token_type: "Bearer",
            scope: "read write",
            expires_in: 3600,
          });
        }
        const verifier = params.get("code_verifier") || "";
        if (
          params.get("code") !== "test-code" ||
          createHash("sha256").update(verifier).digest("base64url") !==
            challenge ||
          params.get("redirect_uri") !== redirectUri
        )
          return send({ error: "invalid_grant" }, 400);
        return send({
          access_token: "test-access",
          refresh_token: "test-refresh",
          token_type: "Bearer",
          scope: "read write",
          expires_in: 3600,
        });
      }
      if (path !== "/mcp") return send({}, 404);
      if (
        req.headers.authorization !== "Bearer test-access" &&
        req.headers.authorization !== "Bearer test-api"
      ) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
        );
        return send({ error: "unauthorized" }, 401);
      }
      if (req.method !== "POST") return send({}, 405);
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0" },
        };
      else if (message.method === "tools/list")
        result = message.params?.cursor
          ? { tools: catalog.slice(2) }
          : { tools: catalog.slice(0, 2), nextCursor: "page-two" };
      else if (message.method === "tools/call") {
        calls.push(message.params);
        result =
          message.params.name === "fail_tool"
            ? {
                isError: true,
                content: [{ type: "text", text: "Operation failed" }],
              }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(message.params.arguments),
                  },
                ],
                structuredContent: {
                  ...message.params.arguments,
                  nextCursor: "keep-provider-cursor",
                },
              };
      } else
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "not found" },
        });
      send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("no address");
  origin = `http://127.0.0.1:${addr.port}`;
  return {
    endpoint: origin + "/mcp",
    calls,
    requests,
    get refreshes() {
      return refreshes;
    },
    authorize: async (url: URL) => {
      challenge = url.searchParams.get("code_challenge") || "";
      const callback = new URL(url.searchParams.get("redirect_uri") || "");
      callback.searchParams.set(
        "state",
        "é".repeat((url.searchParams.get("state") || "").length),
      );
      callback.searchParams.set("code", "test-code");
      const invalid = await fetch(callback);
      if (invalid.status !== 400) throw Error("bad state accepted");
      callback.searchParams.set("state", url.searchParams.get("state") || "");
      const response = await fetch(callback);
      if (response.status !== 200) throw Error("callback failed");
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
