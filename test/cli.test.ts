import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fixture, catalog } from "./fixture.js";
import { login, status } from "../src/auth.js";
import { Store } from "../src/store.js";
import { withSession } from "../src/mcp.js";
import { argumentsFor, resolveTool } from "../src/arguments.js";
const run = promisify(execFile);
async function windowsAcl(path: string, script: string) {
  return run(
    join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference = 'Stop'\n$env:PSModulePath = "$PSHOME\\Modules"\n${script}`,
        "utf16le",
      ).toString("base64"),
    ],
    { windowsHide: true, env: { ...process.env, LINEAR_TEST_ACL_PATH: path } },
  );
}
const grantEveryone = `
$acl = Get-Acl -LiteralPath $env:LINEAR_TEST_ACL_PATH
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'Read', 'Allow'))
[System.IO.File]::SetAccessControl($env:LINEAR_TEST_ACL_PATH, $acl)
`;
function cli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      env: {
        ...process.env,
        LINEAR_API_KEY: "",
        LINEAR_ACCESS_TOKEN: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}
test("CLI help and no-auth doctor work offline, JSON errors are parseable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-test-"));
  try {
    const env = { LINEAR_CONFIG_DIR: dir };
    const help = await cli(["--help"], env);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /initiatives/);
    assert.match(help.stdout, /auth/);
    const doctor = await cli(["--json", "doctor", "--offline"], env);
    assert.equal(doctor.code, 0);
    assert.equal(JSON.parse(doctor.stdout).data.authenticated, false);
    assert.equal(doctor.stderr, "");
    const call = await cli(["--json", "tools", "list"], env);
    assert.equal(call.code, 1);
    assert.equal(JSON.parse(call.stdout).error.code, "AUTH_REQUIRED");
    const bad = await cli(["--json", "no-such-command"], env);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.stdout).ok, false);
    assert.equal(bad.stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("schema flags support objects/arrays, numbers, booleans, positional IDs and current save aliases", async () => {
  const parsed = await argumentsFor(
    catalog[0],
    [
      "--include-archived",
      "false",
      "--priority",
      "1.5",
      "--labels",
      "a",
      "--labels",
      '["b","c"]',
    ],
    true,
  );
  assert.deepEqual(parsed.args, {
    includeArchived: false,
    priority: 1.5,
    labels: ["a", "b", "c"],
    limit: 50,
  });
  assert.deepEqual((await argumentsFor(catalog[1], ["ENG-123"], true)).args, {
    id: "ENG-123",
  });
  assert.equal(resolveTool(catalog, "issues", "create").name, "save_issue");
  assert.equal(resolveTool(catalog, "issues", "update").name, "save_issue");
  await assert.rejects(
    argumentsFor(catalog[0], ["--limit", "251"], true),
    /limit/,
  );
  await assert.rejects(
    argumentsFor(catalog[2], ["--title", "t", "--team", "x", "--unknown", "v"]),
    /Unknown field/,
  );
  const dry = await argumentsFor(catalog[2], [
    "--data",
    '{"title":"new","metadata":{"a":1}}',
    "--dry-run",
  ]);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.args.metadata, { a: 1 });
});
test("hosted tool pages, schema flags, dry runs, stdin and tool errors through installed entrypoint", async () => {
  const server = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "linear-test-"));
  const env = {
    LINEAR_CONFIG_DIR: dir,
    LINEAR_API_KEY: "test-api",
    LINEAR_MCP_URL: server.endpoint,
  };
  try {
    await writeFile(join(dir, "default.json"), "corrupt", { mode: 0o600 });
    const discovery = await cli(["--json", "tools", "list"], env);
    assert.equal(discovery.code, 0, discovery.stderr + discovery.stdout);
    assert.equal(JSON.parse(discovery.stdout).data.tools.length, 5);
    assert.match(discovery.stdout, /First discover/);
    const call = await cli(
      ["issues", "list", "--include-archived", "--limit", "3", "--json"],
      env,
    );
    assert.equal(call.code, 0, call.stdout + call.stderr);
    assert.deepEqual(server.calls.at(-1)?.arguments, {
      includeArchived: true,
      limit: 3,
    });
    assert.equal(
      JSON.parse(call.stdout).data.result.structuredContent.nextCursor,
      "keep-provider-cursor",
    );
    const dry = await cli(
      ["--json", "issues", "create", "--title", "draft", "--dry-run"],
      env,
    );
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.equal(JSON.parse(dry.stdout).data.dryRun, true);
    assert.equal(server.calls.length, 1);
    const future = await cli(
      ["--json", "tool", "future_tool", "--data", "-"],
      env,
      '{"enabled":false}',
    );
    assert.equal(future.code, 0);
    assert.deepEqual(server.calls.at(-1)?.arguments, { enabled: false });
    const fail = await cli(["--json", "tools", "call", "fail_tool"], env);
    assert.equal(fail.code, 1);
    assert.equal(JSON.parse(fail.stdout).error.code, "TOOL_ERROR");
    const authStatus = await cli(["--json", "auth", "status"], env);
    assert.equal(authStatus.code, 0);
    assert.equal(
      JSON.parse(authStatus.stdout).data.source,
      "env:LINEAR_API_KEY",
    );
    assert.doesNotMatch(authStatus.stdout, /test-api/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("OAuth dynamic registration, PKCE, state validation, isolated profiles and serialized refresh", async () => {
  const server = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "linear-test-"));
  const store = new Store("work", dir);
  const previous = process.env.LINEAR_CONFIG_DIR;
  process.env.LINEAR_CONFIG_DIR = dir;
  try {
    await login(
      store,
      server.endpoint,
      { timeoutMs: 5000, scope: "read write" },
      server.authorize,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(store.file)).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
    assert.equal((await status(store)).source, "oauth");
    assert.equal(await new Store("personal", dir).read(), undefined);
    const data = await store.read();
    assert.ok(data);
    assert.equal(data.tokens?.issuer, server.endpoint.replace("/mcp", ""));
    assert.ok(data.client?.issuer);
    data.expiresAt = Date.now() - 100;
    await store.write(data);
    await Promise.all([
      withSession({ profile: "work", timeoutMs: 3000 }, (session) =>
        session.tools(),
      ),
      withSession({ profile: "work", timeoutMs: 3000 }, (session) =>
        session.tools(),
      ),
    ]);
    assert.equal(server.refreshes, 1);
    assert.ok(server.requests.includes("POST /register"));
    assert.ok(server.requests.includes("POST /token"));
  } finally {
    if (previous === undefined) delete process.env.LINEAR_CONFIG_DIR;
    else process.env.LINEAR_CONFIG_DIR = previous;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("OAuth timeout cleans callback and does not overwrite an existing profile", async () => {
  const server = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "linear-test-"));
  const store = new Store("default", dir);
  try {
    await store.write({ endpoint: server.endpoint });
    await assert.rejects(
      login(
        store,
        server.endpoint,
        { timeoutMs: 100, scope: "read" },
        async () => {},
      ),
      /timed out/,
    );
    assert.deepEqual(await store.read(), { endpoint: server.endpoint });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("save aliases preserve create/update intent and full catalog is opt-in", async () => {
  const server = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "linear-test-"));
  const env = {
    LINEAR_CONFIG_DIR: dir,
    LINEAR_API_KEY: "test-api",
    LINEAR_MCP_URL: server.endpoint,
  };
  try {
    const update = await cli(
      ["--json", "issues", "update", "--title", "oops"],
      env,
    );
    assert.equal(update.code, 1);
    assert.match(JSON.parse(update.stdout).error.message, /requires --id/);
    const create = await cli(
      ["--json", "issues", "create", "--id", "existing", "--title", "oops"],
      env,
    );
    assert.equal(create.code, 1);
    assert.match(
      JSON.parse(create.stdout).error.message,
      /cannot include --id/,
    );
    assert.equal(server.calls.length, 0);
    const validUpdate = await cli(
      [
        "--json",
        "issues",
        "update",
        "--id",
        "ENG-1",
        "--title",
        "new",
        "--dry-run",
      ],
      env,
    );
    assert.equal(validUpdate.code, 0, validUpdate.stdout);
    assert.equal(JSON.parse(validUpdate.stdout).data.arguments.id, "ENG-1");
    const list = await cli(["--json", "tools", "list"], env);
    assert.equal(JSON.parse(list.stdout).data.tools[0].inputSchema, undefined);
    const full = await cli(["--json", "tools", "list", "--full"], env);
    assert.ok(JSON.parse(full.stdout).data.tools[0].inputSchema);
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("new draft2020-12 tools validate and raw calls retain provider pagination bounds", async () => {
  const tool = {
    name: "list_future_things",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object" as const,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 3 },
        options: { type: "object" },
      },
      required: ["limit"],
    },
  };
  assert.deepEqual(
    (await argumentsFor(tool, ["--options", '{"enabled":true}'], true)).args,
    { limit: 3, options: { enabled: true } },
  );
  await assert.rejects(argumentsFor(tool, ["--limit", "4"], true), /limit/);
  assert.equal(
    (await argumentsFor(catalog[0], ["--limit", "300"])).args.limit,
    300,
  );
});
test("secret redaction and unsafe credential files fail cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-test-"));
  const store = new Store("default", dir);
  try {
    await writeFile(
      store.file,
      JSON.stringify({
        endpoint: "https://mcp.linear.app/mcp",
        tokens: { access_token: "private-access", token_type: "Bearer" },
      }),
      { mode: 0o644 },
    );
    if (process.platform === "win32")
      await windowsAcl(store.file, grantEveryone);
    const unsafe = await cli(["--json", "auth", "status"], {
      LINEAR_CONFIG_DIR: dir,
    });
    assert.equal(unsafe.code, 1);
    assert.equal(JSON.parse(unsafe.stdout).error.code, "UNSAFE_CONFIG");
    assert.doesNotMatch(unsafe.stdout, /private-access/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "Windows credential checks ignore incompatible inherited PowerShell modules",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "linear-module-path-"));
    try {
      const modules = join(dir, "modules");
      const module = join(modules, "Microsoft.PowerShell.Security");
      await mkdir(module, { recursive: true });
      await writeFile(
        join(module, "Microsoft.PowerShell.Security.psm1"),
        'function Get-Acl { throw "Incompatible inherited module was loaded" }\nExport-ModuleMember -Function Get-Acl\n',
      );
      const credentials = join(dir, "credentials");
      await new Store("default", credentials).write({
        endpoint: "https://mcp.linear.app/mcp",
      });
      const result = await cli(["--json", "auth", "status"], {
        LINEAR_CONFIG_DIR: credentials,
        PSModulePath: modules,
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).data.authenticated, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Windows credential ACLs survive replacement and reject unrelated readers",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "linear-acl-'$-"));
    const store = new Store("default", dir);
    try {
      const credentials = {
        endpoint: "https://mcp.linear.app/mcp",
        tokens: { access_token: "private-access", token_type: "Bearer" },
      };
      await store.write(credentials);
      assert.deepEqual(await store.read(), credentials);
      await store.write({ ...credentials, expiresAt: 123 });
      assert.equal((await store.read())?.expiresAt, 123);
      for (const path of [dir, store.file]) {
        const { stdout } = await windowsAcl(
          path,
          `
$acl = Get-Acl -LiteralPath $env:LINEAR_TEST_ACL_PATH
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
@{
  protected = $acl.AreAccessRulesProtected
  owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  readers = @($rules | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Value })
} | ConvertTo-Json -Compress
`,
        );
        const acl = JSON.parse(stdout);
        assert.equal(acl.protected, true);
        assert.equal(acl.owner, acl.user);
        assert.deepEqual(
          acl.readers.sort(),
          [acl.user, "S-1-5-18", "S-1-5-32-544"].sort(),
        );
      }
      await windowsAcl(store.file, grantEveryone);
      await assert.rejects(store.read(), (error: unknown) => {
        assert.equal((error as { code: string }).code, "UNSAFE_CONFIG");
        assert.doesNotMatch(String(error), /private-access/);
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test("known secrets, bearer headers and OAuth code query values are redacted", async () => {
  const { rememberSecret, redact } = await import("../src/errors.js");
  rememberSecret("known-secret-value");
  assert.deepEqual(
    redact({
      message: "known-secret-value Bearer another-secret",
      access_token: "anything",
      url: "https://example.com/callback?code=private-code&state=state",
    }),
    {
      message: "[REDACTED] Bearer [REDACTED]",
      access_token: "[REDACTED]",
      url: "https://example.com/callback?code=[REDACTED]&state=state",
    },
  );
});
test("saved OAuth grants cannot be reused at a different endpoint", async () => {
  const server = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "linear-test-"));
  const store = new Store("default", dir);
  const previous = process.env.LINEAR_CONFIG_DIR;
  process.env.LINEAR_CONFIG_DIR = dir;
  try {
    await login(
      store,
      server.endpoint,
      { timeoutMs: 5000, scope: "read write" },
      server.authorize,
    );
    await assert.rejects(
      withSession(
        {
          profile: "default",
          endpoint: "http://127.0.0.1:1/mcp",
          timeoutMs: 1000,
        },
        (session) => session.tools(),
      ),
      /No OAuth login for this endpoint/,
    );
  } finally {
    if (previous === undefined) delete process.env.LINEAR_CONFIG_DIR;
    else process.env.LINEAR_CONFIG_DIR = previous;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
