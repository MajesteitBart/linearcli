import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import openBrowser from "open";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { CliError, rememberSecret } from "./errors.js";
import { Store, DEFAULT_ENDPOINT, type Credentials } from "./store.js";
export function timedFetch(
  timeoutMs: number,
  outer?: AbortSignal,
): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(init?.signal ? [init.signal] : []),
        ...(outer ? [outer] : []),
      ]),
    });
}
export class Provider implements OAuthClientProvider {
  private verifier?: string;
  constructor(
    public data: Credentials,
    private store: Store,
    private interactive = false,
    private onRedirect?: (url: URL) => Promise<void>,
    private oauthState?: string,
  ) {}
  get redirectUrl() {
    return this.data.redirectUrl || "http://127.0.0.1/oauth/callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Linear CLI",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return this.oauthState || randomBytes(32).toString("base64url");
  }
  clientInformation() {
    return this.data.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    this.data.client = client;
    rememberSecret(client.client_secret);
    await this.persist();
  }
  tokens() {
    return this.data.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    this.data.tokens = tokens;
    this.data.expiresAt =
      tokens.expires_in === undefined
        ? undefined
        : Date.now() + tokens.expires_in * 1000;
    rememberSecret(tokens.access_token);
    rememberSecret(tokens.refresh_token);
    await this.persist();
  }
  async redirectToAuthorization(url: URL) {
    if (!this.interactive || !this.onRedirect)
      throw new CliError(
        "AUTH_REQUIRED",
        `Run linear auth login --profile ${this.store.profile}.`,
      );
    await this.onRedirect(url);
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
    rememberSecret(verifier);
  }
  codeVerifier() {
    if (!this.verifier)
      throw new CliError(
        "AUTH_REQUIRED",
        "No active login; run linear auth login.",
      );
    return this.verifier;
  }
  discoveryState() {
    return this.data.discovery;
  }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.data.discovery = discovery;
    await this.persist();
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    if (scope === "all" || scope === "client") delete this.data.client;
    if (scope === "all" || scope === "tokens") {
      delete this.data.tokens;
      delete this.data.expiresAt;
    }
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") delete this.data.discovery;
    await this.persist();
  }
  private async persist() {
    if (!this.interactive) await this.store.write(this.data);
  }
}
export function envToken() {
  const value = process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN;
  rememberSecret(value);
  return value
    ? {
        token: value,
        source: process.env.LINEAR_API_KEY
          ? "env:LINEAR_API_KEY"
          : "env:LINEAR_ACCESS_TOKEN",
      }
    : undefined;
}
export async function status(store: Store, endpoint?: string) {
  const env = envToken();
  const data = env ? undefined : await store.read();
  return {
    profile: store.profile,
    endpoint: endpoint || data?.endpoint || DEFAULT_ENDPOINT,
    authenticated: !!(env || data?.tokens),
    source: env?.source || (data?.tokens ? "oauth" : "missing"),
    scope: data?.tokens?.scope,
    expiresAt: data?.expiresAt
      ? new Date(data.expiresAt).toISOString()
      : undefined,
    canRefresh: !!data?.tokens?.refresh_token,
  };
}
export async function login(
  store: Store,
  endpoint: string,
  options: {
    noBrowser?: boolean;
    timeoutMs: number;
    scope: string;
    port?: number;
  },
  redirect?: (url: URL) => Promise<void>,
) {
  return store.locked(async () => {
    const controller = new AbortController();
    const state = randomBytes(32).toString("base64url");
    let resolveCode!: (value: string) => void;
    let rejectCode!: (value: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    void codePromise.catch(() => {});
    let finished = false;
    const server = createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url || "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end("Invalid callback URL.");
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end("Callback requires GET.");
        return;
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const received = Buffer.from(url.searchParams.get("state") || "");
      const expected = Buffer.from(state);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      ) {
        res
          .writeHead(400)
          .end("Invalid OAuth state. Return to the original login link.");
        return;
      }
      if (finished) {
        res.writeHead(409).end("This login callback was already used.");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) {
        finished = true;
        res
          .writeHead(400)
          .end("Authorization was declined. Return to the terminal.");
        rejectCode(new CliError("AUTH_DENIED", "Authorization was declined."));
        return;
      }
      if (!code) {
        res.writeHead(400).end("Missing authorization code.");
        return;
      }
      finished = true;
      res.end(
        "Authorization received. Return to the terminal to check login completion.",
      );
      rememberSecret(code);
      resolveCode(code);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port || 0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new CliError(
        "CALLBACK_FAILED",
        "Cannot start the loopback callback.",
      );
    const timer = setTimeout(() => {
      const error = new CliError(
        "LOGIN_TIMEOUT",
        "OAuth login timed out. Run linear auth login to retry.",
      );
      controller.abort(error);
      rejectCode(error);
    }, options.timeoutMs);
    const data: Credentials = {
      endpoint,
      redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
    };
    const provider = new Provider(
      data,
      store,
      true,
      async (url) => {
        if (redirect) {
          await redirect(url);
          return;
        }
        process.stderr.write(
          `Authorize Linear CLI in your browser:\n${url.href}\n`,
        );
        if (!options.noBrowser) {
          try {
            await openBrowser(url.href, { wait: false });
          } catch {
            process.stderr.write(
              "Could not open a browser. Open the URL above on this machine.\n",
            );
          }
        }
      },
      state,
    );
    try {
      const fetchFn = timedFetch(
        Math.min(options.timeoutMs, 30_000),
        controller.signal,
      );
      const result = await auth(provider, {
        serverUrl: endpoint,
        scope: options.scope,
        fetchFn,
      });
      if (result !== "AUTHORIZED") {
        const code = await codePromise;
        if (
          (await auth(provider, {
            serverUrl: endpoint,
            authorizationCode: code,
            scope: options.scope,
            fetchFn,
          })) !== "AUTHORIZED"
        )
          throw new CliError(
            "AUTH_FAILED",
            "Linear did not complete authorization.",
          );
      }
      if (!data.tokens)
        throw new CliError(
          "AUTH_FAILED",
          "Linear did not issue an access token.",
        );
      await store.write(data);
      return {
        profile: store.profile,
        endpoint,
        authenticated: true,
        source: "oauth",
        scope: data.tokens.scope,
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
}
