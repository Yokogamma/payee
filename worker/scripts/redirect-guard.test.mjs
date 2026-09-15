import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A source scan, deliberately dumb, deliberately here.
 *
 * The behavioural tests cover the two readers that exist today; this one
 * covers the ones nobody has written yet. `redirect: 'error'` is refused by
 * workerd with a TypeError before any I/O, so a call site carrying it is dead
 * on arrival — and a dead call site on a path no test exercises is precisely
 * how the original defect survived: it looked like a hardening option, it
 * type-checked, and every stub ignored `init`.
 *
 * It lives in `worker/scripts/` because it reads `node:fs`, which the workers
 * pool does not provide — the root vitest config claims the worker's script
 * tests for the plain-Node run for exactly this reason.
 *
 * The CLIENT is not scanned: `src/lib/arweave.ts` runs in a browser, where the
 * mode is valid per the Fetch standard, and four call sites depend on it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = join(HERE, '..', 'src');

async function tsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('worker sources and the redirect mode', () => {
  it('no source under worker/src passes redirect: "error"', async () => {
    const files = await tsFiles(WORKER_SRC);
    expect(files.length).toBeGreaterThan(0); // the walk itself must not silently find nothing

    const offenders = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/redirect\s*:\s*['"]error['"]/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }

    expect(offenders, `workerd refuses redirect:"error" — use "manual" and check the status: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('the gateway readers ask for "manual" explicitly', async () => {
    // Not merely "not error": `follow` would let one host answer for two
    // configured origins, which is the pooling flaw the mode exists to stop.
    for (const file of ['publication-auth.ts', 'index.ts']) {
      const text = await readFile(join(WORKER_SRC, file), 'utf8');
      expect(text, `${file} must pin the redirect mode`).toMatch(/redirect\s*:\s*'manual'/);
    }
  });
});
