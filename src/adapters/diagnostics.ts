import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export interface DiagnosticEntry { path: string; kind: 'file' | 'directory'; digest: string | null; size: number }
export interface DiagnosticManifest { root: string; entries: DiagnosticEntry[] }
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Never follow links, delete recursively, or remove a file not in the durable manifest. */
export class DiagnosticsDirectory {
  async inspect(root: string): Promise<DiagnosticManifest> {
    if (await realpath(dirname(root)) !== dirname(root)) throw new Error('Diagnostic parent is linked');
    const entries: DiagnosticEntry[] = [];
    const walk = async (path: string): Promise<void> => {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Diagnostic artefact is linked or not regular');
      // Manifests use / on every platform so that they are portable and comparable.
      const file = relative(root, path).split(sep).join('/');
      if (stat.isDirectory()) {
        for (const name of (await readdir(path)).sort()) await walk(join(path, name));
        entries.push({ path: file, kind: 'directory', digest: null, size: 0 });
      } else entries.push({ path: file, kind: 'file', digest: createHash('sha256').update(await readFile(path)).digest('hex'), size: stat.size });
    };
    try { await lstat(root); }
    catch (error) { if (absent(error)) return { root, entries }; throw error; }
    await walk(root);
    return { root, entries };
  }

  /** Missing entries are progress from an interrupted deletion, not permission to delete new files. */
  async remove(manifest: DiagnosticManifest): Promise<void> {
    const current = await this.inspect(manifest.root);
    for (const entry of current.entries) {
      const original = manifest.entries.find(item => item.path === entry.path);
      if (!original || original.kind !== entry.kind || original.digest !== entry.digest || original.size !== entry.size) throw new Error('Diagnostic directory changed');
    }
    for (const entry of manifest.entries) {
      const path = join(manifest.root, ...entry.path.split('/'));
      try {
        // Recheck ancestry and contents before each removal.
        const remaining = await this.inspect(manifest.root);
        const found = remaining.entries.find(item => item.path === entry.path);
        if (!found) continue;
        if (found.kind !== entry.kind || found.digest !== entry.digest || found.size !== entry.size) throw new Error('Diagnostic artefact changed');
        if (entry.kind === 'directory') await rmdir(path);
        else await unlink(path);
      } catch (error) { if (!absent(error)) throw error; }
    }
  }
}
