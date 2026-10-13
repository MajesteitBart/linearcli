import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { CliError } from "./errors.js";

const run = promisify(execFile);
const script = `
$ErrorActionPreference = 'Stop'
try {
  $path = $env:LINEAR_ACL_PATH
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) {
    throw 'Credentials and their directory must be owned by you.'
  }
  $allowed = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  if ($env:LINEAR_ACL_ACTION -eq 'protect') {
    $directory = (Get-Item -LiteralPath $path -Force).PSIsContainer
    if ($directory) {
      $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
      $acl.RemoveAccessRuleSpecific($rule)
    }
    foreach ($value in $allowed) {
      $sid = [System.Security.Principal.SecurityIdentifier]::new($value)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inherit, [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    if ($directory) {
      [System.IO.Directory]::SetAccessControl($path, $acl)
    } else {
      [System.IO.File]::SetAccessControl($path, $acl)
    }
    $acl = Get-Acl -LiteralPath $path
  }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) {
      throw 'Credentials are accessible to other users. Restrict the Windows ACL to your account, SYSTEM and Administrators.'
    }
  }
} catch {
  [Console]::Out.WriteLine($_.Exception.Message)
  exit 1
}
`;

export async function windowsPermissions(
  path: string,
  action: "check" | "protect",
) {
  try {
    await run(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          LINEAR_ACL_PATH: path,
          LINEAR_ACL_ACTION: action,
        },
      },
    );
  } catch (error) {
    const output = (error as { stdout?: string }).stdout?.trim();
    throw new CliError(
      "UNSAFE_CONFIG",
      output || `Cannot ${action} Windows credential permissions: ${path}`,
    );
  }
}
