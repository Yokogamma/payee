import { describe, it, expect } from 'vitest';
import { groupSafeboxChains, byCurrentness } from './chains';
import { applySafeboxPatch, snapshotSafeboxVersion, matchesSafeboxQuery, SafeboxPatchError } from './safebox';
import { uniformIndex, generateRandomPassword, generatePassphrase, PASSPHRASE_SEPARATOR } from './password-gen';
import type { SafeboxEntryData, SafeboxSecretData } from './crypto';

// §8: chain grouping over the AUTHENTICATED fields, the patch contract, the
// safebox-only search scope, and a DETERMINISTIC generator test (no histograms).

function meta(over: Partial<SafeboxEntryData> & { id: string }): SafeboxEntryData {
  return {
    createdAt: 1000, title: 't', login: '', url: '', note: '',
    files: [], rev: 1, root: over.id, ...over,
  };
}

describe('groupSafeboxChains', () => {
  it('groups by root and picks the latest version as current', () => {
    const root = 'r1';
    const entries = [
      meta({ id: root, rev: 1, root, createdAt: 1000 }),
      meta({ id: 'v2', rev: 2, root, prev: root, createdAt: 2000 }),
      meta({ id: 'other', rev: 1, root: 'other', createdAt: 1500 }),
    ];
    const chains = groupSafeboxChains(entries);
    expect(chains).toHaveLength(2);
    const chain = chains.find(c => c.root === root)!;
    expect(chain.current.id).toBe('v2');
    expect(chain.versions.map(v => v.id)).toEqual(['v2', root]); // current-first
  });

  it('uses the ENVELOPE fields, so a forged outer value cannot promote an old version', () => {
    // Both versions are grouped by their AUTHENTICATED `root`/`rev`/`t`. The
    // outer record createdAt is never passed in here — this is the structural
    // reason a locally-edited row cannot make an old password «current».
    const root = 'r1';
    const chain = groupSafeboxChains([
      meta({ id: root, rev: 1, root, createdAt: 1000 }),
      meta({ id: 'v2', rev: 2, root, prev: root, createdAt: 2000 }),
    ])[0];
    expect(chain.current.rev).toBe(2);

    // Same set, with the OLD version claiming a newer envelope timestamp: the
    // fork rule (createdAt DESC, then rev DESC) is deterministic either way.
    const forked = groupSafeboxChains([
      meta({ id: root, rev: 1, root, createdAt: 3000 }),
      meta({ id: 'v2', rev: 2, root, prev: root, createdAt: 2000 }),
    ])[0];
    expect(forked.current.id).toBe(root); // the accepted, DOCUMENTED fork rule
  });

  it('byCurrentness tie-breaks deterministically: createdAt, then rev, then id', () => {
    const a = meta({ id: 'aaa', rev: 2, root: 'r', createdAt: 1000 });
    const b = meta({ id: 'bbb', rev: 2, root: 'r', createdAt: 1000 });
    expect(byCurrentness(a, b)).toBeLessThan(0);
    const higherRev = meta({ id: 'zzz', rev: 3, root: 'r', createdAt: 1000 });
    expect(byCurrentness(higherRev, a)).toBeLessThan(0);
  });
});

describe('search scope (non-secret fields only)', () => {
  const entry = meta({
    id: 'e1', title: 'GitHub', login: 'yoko', url: 'https://github.com',
    note: 'рабочий', files: [{ fid: 'f1', name: 'id_rsa', mime: 'text/plain', size: 3 }],
  });

  it('matches title / login / url / note', () => {
    for (const q of ['github', 'YOKO', 'github.com', 'рабоч']) {
      expect(matchesSafeboxQuery(entry, q)).toBe(true);
    }
  });

  it('does NOT match attachment names (and cannot match a password — it is not here)', () => {
    expect(matchesSafeboxQuery(entry, 'id_rsa')).toBe(false);
    // SafeboxEntryData has no password field at all: the search path physically
    // cannot see one.
    expect('password' in entry).toBe(false);
  });

  it('an empty query matches everything', () => {
    expect(matchesSafeboxQuery(entry, '   ')).toBe(true);
  });
});

describe('patch contract (§6)', () => {
  const current = {
    meta: meta({
      id: 'v1', title: 'Old', login: 'u', url: 'x', note: 'n',
      files: [
        { fid: 'fa', name: 'a.pem', mime: 'text/plain', size: 3 },
        { fid: 'fb', name: 'b.pem', mime: 'text/plain', size: 3 },
      ],
    }),
    secret: {
      password: 'OLD-PASSWORD',
      files: [{ fid: 'fa', data: 'YWFh' }, { fid: 'fb', data: 'YmJi' }],
    } as SafeboxSecretData,
  };

  it('editing only the META keeps the password AND every file byte-for-byte', () => {
    const next = applySafeboxPatch(current, {
      title: 'New', login: 'u2', url: 'x', note: 'n',
      files: [{ kind: 'keep', fid: 'fa' }, { kind: 'keep', fid: 'fb' }],
    });
    expect(next.title).toBe('New');
    expect(next.password).toBe('OLD-PASSWORD'); // NO action ⇒ carried over
    expect(next.files.map(f => f.fid)).toEqual(['fa', 'fb']);
    expect(next.files.map(f => f.data)).toEqual(['YWFh', 'YmJi']);
  });

  it('removing ONE file leaves the others (and the password) untouched', () => {
    const next = applySafeboxPatch(current, {
      title: 'Old', login: 'u', url: 'x', note: 'n',
      files: [{ kind: 'keep', fid: 'fb' }], // 'fa' simply omitted = removed
    });
    expect(next.files.map(f => f.fid)).toEqual(['fb']);
    expect(next.password).toBe('OLD-PASSWORD');
  });

  it('replacing the password does not touch the files', () => {
    const next = applySafeboxPatch(current, {
      title: 'Old', login: 'u', url: 'x', note: 'n',
      password: { kind: 'replace', value: 'NEW' },
      files: [{ kind: 'keep', fid: 'fa' }, { kind: 'keep', fid: 'fb' }],
    });
    expect(next.password).toBe('NEW');
    expect(next.files).toHaveLength(2);
  });

  it('a replacement file arrives as a NEW fid (never rebinding an old descriptor)', () => {
    const next = applySafeboxPatch(current, {
      title: 'Old', login: 'u', url: 'x', note: 'n',
      files: [
        { kind: 'keep', fid: 'fb' },
        { kind: 'add', fid: 'fc', name: 'a.pem', mime: 'text/plain', size: 3, data: 'Y2Nj' },
      ],
    });
    expect(next.files.map(f => f.fid)).toEqual(['fb', 'fc']);
    expect(next.files.find(f => f.fid === 'fc')?.data).toBe('Y2Nj');
    expect(next.files.some(f => f.fid === 'fa')).toBe(false);
  });

  it('rejects keeping an unknown fid and duplicate actions', () => {
    expect(() => applySafeboxPatch(current, {
      title: 't', login: '', url: '', note: '', files: [{ kind: 'keep', fid: 'nope' }],
    })).toThrow(SafeboxPatchError);
    expect(() => applySafeboxPatch(current, {
      title: 't', login: '', url: '', note: '',
      files: [{ kind: 'keep', fid: 'fa' }, { kind: 'keep', fid: 'fa' }],
    })).toThrow(SafeboxPatchError);
  });
});

describe('snapshotSafeboxVersion (restore = the WHOLE entry)', () => {
  it('carries title/login/url/note/password AND every attachment', () => {
    const m = meta({
      id: 'old', title: 'Старый', login: 'l', url: 'u', note: 'n',
      files: [{ fid: 'fa', name: 'a', mime: 'text/plain', size: 3 }],
    });
    const s: SafeboxSecretData = { password: 'P', files: [{ fid: 'fa', data: 'YWFh' }] };
    expect(snapshotSafeboxVersion(m, s)).toEqual({
      title: 'Старый', login: 'l', url: 'u', note: 'n', password: 'P',
      files: [{ fid: 'fa', name: 'a', mime: 'text/plain', size: 3, data: 'YWFh' }],
    });
  });

  it('throws when a descriptor has no matching content', () => {
    const m = meta({ id: 'old', files: [{ fid: 'fa', name: 'a', mime: 't', size: 1 }] });
    expect(() => snapshotSafeboxVersion(m, { password: 'p', files: [] })).toThrow(SafeboxPatchError);
  });
});

describe('password generator — DETERMINISTIC rejection-sampling test', () => {
  /** Feeds an exact byte sequence so the rejection path is observable. */
  function bytes(sequence: number[]) {
    let i = 0;
    return () => new Uint8Array([sequence[i++ % sequence.length]]);
  }

  it('rejects bytes at/above the largest multiple of the alphabet size and RE-DRAWS', () => {
    // size 10 → limit = 250. 250..255 must be discarded, not folded with %.
    const draws = [250, 251, 255, 7];
    expect(uniformIndex(10, bytes(draws))).toBe(7);
  });

  it('maps accepted bytes with a plain modulo (no bias inside the accepted range)', () => {
    expect(uniformIndex(10, bytes([0]))).toBe(0);
    expect(uniformIndex(10, bytes([9]))).toBe(9);
    expect(uniformIndex(10, bytes([249]))).toBe(9);   // 249 < 250 → accepted
    expect(uniformIndex(16, bytes([255]))).toBe(15);  // 256 % 16 == 0 → nothing rejected
  });

  it('produces exactly the alphabet symbols the accepted bytes select', () => {
    const alphabet = 'abcdefghij'; // 10 symbols → limit 250
    // 250 is rejected, then 0,1,2 select a,b,c.
    expect(generateRandomPassword(3, alphabet, bytes([250, 0, 1, 2]))).toBe('abc');
  });

  it('rejects an unusable alphabet size', () => {
    expect(() => uniformIndex(0, bytes([1]))).toThrow();
    expect(() => uniformIndex(300, bytes([1]))).toThrow();
    expect(() => generateRandomPassword(4, '', bytes([1]))).toThrow();
  });

  it('the passphrase draws from the full 2048-word list and joins with "-"', () => {
    // hi=0 (byte 0 → 0 % 8), lo=0 → wordlist[0] === 'abandon'; then hi=7, lo=255
    // → wordlist[2047] === 'zoo'.
    const phrase = generatePassphrase(2, bytes([0, 0, 7, 255]));
    expect(phrase.split(PASSPHRASE_SEPARATOR)).toEqual(['abandon', 'zoo']);
  });

  it('the real generator honours the requested length', () => {
    expect(generateRandomPassword(24, 'abcdefghijklmnopqrstuvwxyz')).toHaveLength(24);
    expect(generatePassphrase(6).split(PASSPHRASE_SEPARATOR)).toHaveLength(6);
  });
});
