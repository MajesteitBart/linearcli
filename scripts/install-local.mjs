import { mkdir, writeFile, chmod, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(homedir(), ".local", "bin");
await mkdir(binDir, { recursive: true });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const script = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "dist", "cli.js"))} "$@"\n`;
for (const name of ["linear", "linear-cli"]) {
  const path = join(binDir, name);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink())
      throw new Error(`Refusing to replace an existing symlink: ${path}`);
    const { readFile } = await import("node:fs/promises");
    if (!(await readFile(path, "utf8")).includes(join(root, "dist", "cli.js")))
      throw new Error(`Refusing to replace an unrelated command: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
  console.log(`Installed ${path}`);
}
console.log(
  "Ensure ~/.local/bin is on PATH. Keep this checkout and node_modules in place.",
);
