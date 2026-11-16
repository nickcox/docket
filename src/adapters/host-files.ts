import { commandRunner } from './command.ts';

/** Windows PowerShell must resolve its own modules, not inherit PowerShell 7's path. */
export function windowsPowerShellEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
}

export class PrivateFileError extends Error {}

export interface WindowsPrivateAcl {
  user: string;
  owner: string;
  entries: { sid: string; allow: boolean }[];
  secured?: boolean;
}

/** R17: administrators can take ownership anyway. This excludes other OS accounts,
 * not processes running as the same user. Keep the rule shared by files and folders. */
export function windowsPrivacyReason(acl: WindowsPrivateAcl): string | null {
  const administrators = 'S-1-5-32-544';
  const trusted = new Set([acl.user, 'S-1-5-18', administrators]);
  const sid = (value: string) => /^S-\d+(?:-\d+)+$/u.test(value) ? value.slice(0, 184) : 'invalid SID';
  const unexpected = [...new Set(acl.entries.filter(entry => entry.allow && !trusted.has(entry.sid)).map(entry => sid(entry.sid)))];
  const reasons: string[] = [];
  if (acl.owner !== acl.user && acl.owner !== administrators) reasons.push('owner mismatch');
  if (unexpected.length) reasons.push(`access entry for another account: ${unexpected.slice(0, 3).join(', ')}${unexpected.length > 3 ? ', additional entries omitted' : ''}`);
  return reasons.length ? `Windows ACL: owner SID ${sid(acl.owner)}; ${reasons.join('; ')}`.slice(0, 1000) : null;
}

const aclSnapshotScript =
  '$acl = Get-Acl -LiteralPath $env:DOCKET_PRIVATE_PATH; ' +
  '$entries = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { ' +
  '@{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq "Allow") } }); ' +
  '@{ user = $sid.Value; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; entries = $entries; secured = $secured } | ConvertTo-Json -Compress -Depth 4';

async function verifyWindowsPrivate(path: string, secure: boolean, runner: typeof commandRunner): Promise<void> {
  const run = runner({ environment: { ...windowsPowerShellEnvironment(), DOCKET_PRIVATE_PATH: path } });
  // Do not SetOwner(user): elevated Windows processes may create Administrators-owned
  // objects and lack the privilege to assign ownership to the unelevated user SID.
  const replace = '$acl = [System.Security.AccessControl.DirectorySecurity]::new(); ' +
    '$acl.SetAccessRuleProtection($true, $false); ' +
    '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow"); ' +
    '$acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:DOCKET_PRIVATE_PATH -AclObject $acl; ';
  const script = '$ErrorActionPreference = "Stop"; ' +
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
    (secure ? replace +
      '$actual = Get-Acl -LiteralPath $env:DOCKET_PRIVATE_PATH; ' +
      '$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); ' +
      '$secured = $actual.AreAccessRulesProtected -and $rules.Count -eq 1; ' +
      'if ($rules.Count -eq 1) { $only = $rules[0]; ' +
      '$secured = $secured -and $only.IdentityReference.Value -eq $sid.Value -and $only.AccessControlType -eq "Allow" ' +
      '-and -not $only.IsInherited -and $only.FileSystemRights -eq 2032127 ' +
      '-and $only.InheritanceFlags -eq 3 -and $only.PropagationFlags -eq 0 }; ' : '') + aclSnapshotScript;
  let acl: WindowsPrivateAcl;
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], process.cwd());
    if (!result.complete || result.code !== 0) throw new Error();
    const value = JSON.parse(result.stdout);
    if (typeof value.user !== 'string' || typeof value.owner !== 'string' || !Array.isArray(value.entries)
      || !value.entries.every((entry: WindowsPrivateAcl['entries'][number]) => entry && typeof entry.sid === 'string' && typeof entry.allow === 'boolean')) throw new Error();
    acl = value;
  } catch { throw new PrivateFileError(secure ? 'Windows directory ACL could not be secured or read' : 'Windows ACL could not be read'); }
  const reason = windowsPrivacyReason(acl);
  if (reason) throw new PrivateFileError(reason);
  if (secure && acl.secured !== true) throw new PrivateFileError('Windows directory ACL replacement could not be verified');
}

/** Replace all access entries, then apply the shared privacy rule before use. */
export async function windowsSecurePrivateDirectory(path: string, runner = commandRunner): Promise<void> {
  await verifyWindowsPrivate(path, true, runner);
}

/** Verify private access, including reads, for either a file or a directory. */
export async function windowsPrivateFile(path: string, runner = commandRunner): Promise<boolean> {
  await verifyWindowsPrivate(path, false, runner);
  return true;
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
