import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const version = '3.1.4';
// SHA-256 digests from the v3.1.4 release's checksums.txt. Update with the version.
const digests = {
  'darwin-amd64': '220f4af729efc2190a43d9b78b5570c87c8a060fc5bf75ee5e2046f9aa19321d',
  'darwin-arm64': 'dd59e3c10549a565d68cd8e98f477c41361678b9f95abc7f1e0fc53bb43587ea',
  'linux-amd64': 'a169277ffdc5f48b51a4b53ce6c2e46fe3c222a5017c67f72bf9260a9b382ae2',
  'linux-arm64': '8d82b132cb952c77992daf9f56f49f8d6a1accb1a973ef235af7fa71bfe6f614',
  'windows-amd64': '0a745ca15f0a39257d55d0d94b01cab43a6c5d894ca00d1d5ac6753d4257cc94',
  'windows-arm64': '31c34f0ac8fa7dbb778f4a9d7395ca9c86a0cfcdeecd509c1759bde420043d34',
};
const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!os || !arch) throw new Error(`Unsupported Treehouse platform: ${process.platform}/${process.arch}`);
const asset = `treehouse-v${version}-${os}-${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
const base = `https://github.com/kunchenguid/treehouse/releases/download/v${version}`;
async function download(name) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let status;
    let retryable = true;
    try {
      const response = await fetch(`${base}/${name}`);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      status = `HTTP ${response.status}`;
      retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
      // Release the response before waiting, without masking its HTTP status.
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      status = `network error: ${error.message}`;
    }
    if (!retryable || attempt === 5) throw new Error(`Download ${name}: ${status}`);
    const seconds = 2 ** attempt;
    console.log(`Retry download ${name}: ${status}; waiting ${seconds}s (attempt ${attempt + 1}/5)`);
    await delay(seconds * 1000);
  }
}
const cacheDirectory = join(process.env.RUNNER_TEMP, 'treehouse-archives');
const cachedArchive = join(cacheDirectory, asset);
let archive;
try {
  archive = await readFile(cachedArchive);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const cacheMiss = archive === undefined;
if (cacheMiss) {
  const checksums = (await download('checksums.txt')).toString('utf8');
  const entries = checksums.split(/\r?\n/).map(line => line.trim().split(/\s+\*?/));
  const matches = entries.filter(([, name]) => name === asset);
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/i.test(matches[0][0])) throw new Error(`Missing or invalid checksum for ${asset}`);
  archive = await download(asset);
  if (createHash('sha256').update(archive).digest('hex') !== matches[0][0].toLowerCase()) throw new Error(`Checksum mismatch for ${asset}`);
}
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== digests[`${os}-${arch}`]) throw new Error(`Stored checksum mismatch for ${asset}`);
if (cacheMiss) {
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(cachedArchive, archive);
}
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
