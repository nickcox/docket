import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const version = '3.1.4';
const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!os || !arch) throw new Error(`Unsupported Treehouse platform: ${process.platform}/${process.arch}`);
const asset = `treehouse-v${version}-${os}-${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
const base = `https://github.com/kunchenguid/treehouse/releases/download/v${version}`;
async function download(name) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) throw new Error(`Download ${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const checksums = (await download('checksums.txt')).toString('utf8');
const entries = checksums.split(/\r?\n/).map(line => line.trim().split(/\s+\*?/));
const matches = entries.filter(([, name]) => name === asset);
if (matches.length !== 1 || !/^[a-f0-9]{64}$/i.test(matches[0][0])) throw new Error(`Missing or invalid checksum for ${asset}`);
const archive = await download(asset);
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== matches[0][0].toLowerCase()) throw new Error(`Checksum mismatch for ${asset}`);
const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'treehouse-'));
const archivePath = join(directory, asset);
const bin = join(directory, 'bin');
await mkdir(bin);
await writeFile(archivePath, archive);
// Windows runners provide bsdtar, which also extracts the release's zip files.
execFileSync('tar', ['-xf', archivePath, '-C', bin], { stdio: 'inherit' });
const executable = join(bin, os === 'windows' ? 'treehouse.exe' : 'treehouse');
if (os !== 'windows') await chmod(executable, 0o755);
execFileSync(executable, ['--version'], { stdio: 'inherit' });
await appendFile(process.env.GITHUB_PATH, `${bin}\n`);
console.log(`Verified ${asset}: SHA-256 ${digest}`);
