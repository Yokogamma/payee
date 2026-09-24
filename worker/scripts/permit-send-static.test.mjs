import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Static gate over worker/src (D10 spec rev. 10 §4.0 «единственный путь к
// сети», §9, §12 permit row 2): the worker performs NO transaction POST outside
// the permit-send path. Structural, deliberately dumb, and here because it
// reads node:fs — the root vitest runs worker/scripts/** in plain Node.
//
// The shape it pins:
//   arweave-transport.ts  — the ONLY file that calls the SDK's
//                           `transactions.post` (inside `postSignedTx`);
//   spend-send.ts         — the ONLY file that calls `postSignedTx`, exactly
//                           once, inside `permittedPost`, AFTER `requestPermit`
//                           in the same function — and the ONLY file that
//                           names the DO route '/permit-send';
//   every other file      — may call `permittedPost`, never the two above.

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const files = readdirSync(srcDir).filter(f => f.endsWith('.ts'));
const read = (f) => readFileSync(join(srcDir, f), 'utf8');

/** The source without block comments and line comments. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}
/** Occurrences of `needle` outside comments. */
function codeOccurrences(text, needle) {
  return stripComments(text).split(needle).length - 1;
}

describe('no transaction POST outside permit-send', () => {
  it('the SDK post is called only inside arweave-transport.ts postSignedTx', () => {
    for (const f of files) {
      const n = codeOccurrences(read(f), 'transactions.post(');
      expect(n, `${f} calls transactions.post ${n} time(s)`).toBe(f === 'arweave-transport.ts' ? 1 : 0);
    }
    const transport = stripComments(read('arweave-transport.ts'));
    const fnStart = transport.indexOf('export async function postSignedTx(');
    expect(fnStart).toBeGreaterThan(0);
    expect(transport.indexOf('transactions.post(')).toBeGreaterThan(fnStart);
  });

  it('postSignedTx is called only inside spend-send.ts permittedPost, once, after requestPermit', () => {
    for (const f of files) {
      const n = codeOccurrences(read(f), 'postSignedTx(');
      // arweave-transport.ts defines it (the definition is not a call).
      const expected = f === 'spend-send.ts' ? 1 : f === 'arweave-transport.ts' ? 1 : 0;
      expect(n, `${f} mentions postSignedTx( ${n} time(s)`).toBe(expected);
    }
    const send = read('spend-send.ts');
    const fnStart = send.indexOf('export async function permittedPost(');
    const permitAt = send.indexOf('await requestPermit(', fnStart);
    const postAt = send.indexOf('await postSignedTx(', fnStart);
    expect(fnStart).toBeGreaterThan(0);
    expect(permitAt).toBeGreaterThan(fnStart);
    expect(postAt).toBeGreaterThan(permitAt);
    // A refused permit returns BEFORE the post (textually between them).
    const between = send.slice(permitAt, postAt);
    expect(between).toMatch(/if \(!permit\.granted\) return/);
  });

  it("the DO route /permit-send is named in spend-send.ts only (and in the DO that serves it)", () => {
    for (const f of files) {
      const n = codeOccurrences(read(f), '/permit-send');
      const expected = f === 'spend-send.ts' ? 1 : f === 'spend-guard.ts' ? 1 : 0;
      expect(n, `${f} names /permit-send ${n} time(s)`).toBe(expected);
    }
    // …and the reference in spend-send.ts is the fetch of that route, the
    // one in the DO its dispatch.
    expect(stripComments(read('spend-send.ts'))).toMatch(/guard\.fetch\('http:\/\/spend-guard\/permit-send'/);
    expect(stripComments(read('spend-guard.ts'))).toMatch(/case '\/permit-send':/);
  });

  it('index.ts does not import postSignedTx and reaches the network through permittedPost', () => {
    const index = stripComments(read('index.ts'));
    expect(index).not.toMatch(/\bpostSignedTx\b/);
    expect(codeOccurrences(index, 'await permittedPost(')).toBe(1);
    expect(index).toMatch(/import \{ permittedPost \} from '\.\/spend-send'/);
  });
});
