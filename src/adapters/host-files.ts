import { commandRunner } from './command.ts';

/** Windows PowerShell must resolve its own modules, not inherit PowerShell 7's path. */
export function windowsPowerShellEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
}

/** Windows mode bits do not describe who can replace person-controlled settings. */
export async function windowsSettingsWritableOnlyByOwner(path: string, runner = commandRunner): Promise<boolean> {
  const run = runner({ environment: { ...windowsPowerShellEnvironment(), DOCKET_SETTINGS_PATH: path } });
  // PowerShell does not use the CRT's backslash-escaped quote rules for -Command.
  // Encode the script so Node's Windows argument quoting cannot strip its strings.
  const script = '$ErrorActionPreference = "Stop"; ' +
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
    '$acl = Get-Acl -LiteralPath $env:DOCKET_SETTINGS_PATH; ' +
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; ' +
    '$trusted = @($user, "S-1-5-18", "S-1-5-32-544"); ' +
    'if ($owner -notin $trusted) { exit 2 }; ' +
    'foreach ($rule in $acl.Access) { ' +
    '$sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; ' +
    'if ($rule.AccessControlType -eq "Allow" -and ($rule.FileSystemRights -band 0xD0156) -ne 0 -and $sid -notin $trusted) { exit 2 } }; exit 0';
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], process.cwd());
  // Exit 2 is reserved for an ACL decision; PowerShell errors normally exit 1.
  if (!result.complete || (result.code !== 0 && result.code !== 2)) throw new Error('Windows owner/write ACL could not be verified');
  return result.code === 0;
}
