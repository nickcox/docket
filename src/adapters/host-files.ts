import { commandRunner } from './command.ts';

/** Windows mode bits do not describe who can replace person-controlled settings. */
export async function windowsSettingsWritableOnlyByOwner(path: string): Promise<boolean> {
  const run = commandRunner({ environment: { ...process.env, DOCKET_SETTINGS_PATH: path } });
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; ' +
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
    '$acl = Get-Acl -LiteralPath $env:DOCKET_SETTINGS_PATH; ' +
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; ' +
    '$trusted = @($user, "S-1-5-18", "S-1-5-32-544"); ' +
    'if ($owner -notin $trusted) { exit 1 }; ' +
    'foreach ($rule in $acl.Access) { ' +
    '$sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; ' +
    'if ($rule.AccessControlType -eq "Allow" -and ($rule.FileSystemRights -band 0xD0156) -ne 0 -and $sid -notin $trusted) { exit 1 } }; exit 0'], process.cwd());
  return result.complete && result.code === 0;
}
