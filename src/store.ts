import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  lstat,
  unlink,
  readdir,
  open,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthTokensSchema,
  OAuthClientInformationSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { CliError, rememberSecret } from "./errors.js";
export const DEFAULT_ENDPOINT = "https://mcp.linear.app/mcp";
export interface Credentials {
  endpoint: string;
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
}
export function configRoot() {
  return (
    process.env.LINEAR_CONFIG_DIR ||
    join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "linear-cli",
    )
  );
}
export function validProfile(profile: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile))
    throw new CliError(
      "INVALID_PROFILE",
      "Profile must contain 1–64 letters, numbers, underscores or hyphens.",
    );
  return profile;
}
export function validEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CliError(
      "INVALID_ENDPOINT",
      "Endpoint must be an absolute HTTPS URL.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new CliError(
      "INVALID_ENDPOINT",
      "Endpoint must use HTTPS (HTTP allowed only on loopback), without credentials, query or fragment.",
    );
  return url.href;
}
async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new CliError(
      "UNSAFE_CONFIG",
      `Config directory must be owned by you and not a symlink: ${path}`,
    );
  await chmod(path, 0o700);
}
export class Store {
  readonly file: string;
  readonly dir: string;
  constructor(
    public profile = "default",
    root = configRoot(),
  ) {
    this.dir = root;
    this.file = join(root, `${validProfile(profile)}.json`);
  }
  async read(): Promise<Credentials | undefined> {
    try {
      const stat = await lstat(this.file);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw new CliError(
          "UNSAFE_CONFIG",
          "Credentials must be a regular file owned by you.",
        );
      if ((stat.mode & 0o077) !== 0)
        throw new CliError(
          "UNSAFE_CONFIG",
          `Credentials are accessible to other users; run chmod 600 '${this.file}'.`,
        );
      const data = JSON.parse(await readFile(this.file, "utf8")) as Credentials;
      if (!data || typeof data.endpoint !== "string")
        throw new Error("Missing endpoint");
      validEndpoint(data.endpoint);
      if (data.tokens && !OAuthTokensSchema.safeParse(data.tokens).success)
        throw new Error("Invalid tokens");
      if (
        data.client &&
        !OAuthClientInformationSchema.safeParse(data.client).success
      )
        throw new Error("Invalid client");
      if (
        data.expiresAt !== undefined &&
        (typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt))
      )
        throw new Error("Invalid expiry");
      rememberSecret(data.tokens?.access_token);
      rememberSecret(data.tokens?.refresh_token);
      rememberSecret(data.client?.client_secret);
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof CliError) throw error;
      throw new CliError(
        "INVALID_CONFIG",
        `Cannot read credentials for profile ${this.profile}.`,
      );
    }
  }
  async write(data: Credentials) {
    await secureDirectory(this.dir);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, this.file);
      await chmod(this.file, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async remove() {
    await rm(this.file, { force: true });
  }
  async profiles() {
    try {
      return (await readdir(this.dir))
        .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(name))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async locked<T>(fn: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    await secureDirectory(this.dir);
    const lockPath = `${this.file}.lock`;
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        );
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
            pid: number;
          };
          if (Number.isSafeInteger(lock.pid) && lock.pid > 0) {
            try {
              process.kill(lock.pid, 0);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ESRCH") {
                await unlink(lockPath);
                continue;
              }
            }
          }
        } catch {
          /* Another process may still be writing its lock. */
        }
        if (Date.now() - started >= timeoutMs)
          throw new CliError(
            "AUTH_BUSY",
            `Another command is using profile ${this.profile}; retry when it finishes.`,
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}
