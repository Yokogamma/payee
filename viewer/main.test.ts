// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BACKUP_CAP_BYTES, encodeBackup, deriveBackupKey } from '../src/lib/backup';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  encryptEnvelopeV3,
  encryptSafeboxEntry,
  bufferToBase64,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from '../src/lib/crypto';

/**
 * The viewer AS A RUNNING PAGE.
 *
 * Everything else about this artifact is checked on its built text — no
 * `http(s)://`, no WebAssembly, the CSP hashes, the anti-autofill attributes.
 * None of that can see what the page DOES, and its two most dangerous
 * behaviours are behaviours: what it puts on disk when a button is clicked,
 * and what it leaves on screen when the tab is left.
 *
 * So this file drives the real module in a real document: it selects a file,
 * clicks «Открыть», reveals a password, dispatches `pagehide`, and asserts on
 * what is actually there afterwards.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Distinctive enough to find anywhere in a rendered document. */
const SECRETS = {
  noteText: 'SENTINEL-NOTE-TEXT-9f3a',
  title: 'SENTINEL-TITLE-4b21',
  login: 'SENTINEL-LOGIN-7c88',
  password: 'SENTINEL-PASSWORD-1d55',
  fileA: 'SENTINEL-BYTES-AAAA',
  fileB: 'SENTINEL-BYTES-BBBBBBBB',
};

const FID_A = 'cccccccc-dddd-4eee-8fff-000000000001';
const FID_B = 'cccccccc-dddd-4eee-8fff-000000000002';

/** The page's own markup, minus the two build placeholders. Resolved from the
 *  project root rather than from `import.meta.url`: under jsdom the module URL
 *  is the document's, not a `file:` one. */
const TEMPLATE = readFileSync(resolve(process.cwd(), 'viewer/index.html'), 'utf8');
const BODY = TEMPLATE
  .slice(TEMPLATE.indexOf('<body>') + '<body>'.length, TEMPLATE.indexOf('</body>'))
  .replace('<script>__JS__</script>', '');

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = () => $('status').textContent ?? '';
const clicks: string[] = [];

async function makeNote(text = SECRETS.noteText): Promise<EncryptedNote> {
  return encryptEnvelopeV3(await deriveKey(MNEMONIC), text, { fmt: 'plain', rev: 1 });
}

async function makeEntry(): Promise<EncryptedSafeboxEntry> {
  return encryptSafeboxEntry(
    await deriveSafeboxMetaKey(MNEMONIC),
    await deriveSafeboxSecretKey(MNEMONIC),
    {
      title: SECRETS.title,
      login: SECRETS.login,
      url: '',
      note: '',
      password: SECRETS.password,
      files: [
        { fid: FID_A, name: 'a.txt', mime: 'text/plain', size: SECRETS.fileA.length, data: btoa(SECRETS.fileA) },
        { fid: FID_B, name: 'b.txt', mime: 'text/plain', size: SECRETS.fileB.length, data: btoa(SECRETS.fileB) },
      ],
      rev: 1,
    },
  );
}

async function container(over: {
  notes?: EncryptedNote[];
  safebox?: EncryptedSafeboxEntry[];
  containsUnsupportedRecords?: boolean;
  incompleteRestore?: boolean;
} = {}): Promise<string> {
  return encodeBackup({
    notes: (over.notes ?? []) as unknown as Record<string, unknown>[],
    safebox: (over.safebox ?? []) as unknown as Record<string, unknown>[],
    incompleteRestore: over.incompleteRestore ?? false,
    containsUnsupportedRecords: over.containsUnsupportedRecords ?? false,
    createdAt: 1_756_000_000_000,
  }, await deriveBackupKey(MNEMONIC));
}

/** A `File` in the only two aspects the page touches. `text` is a spy so the
 *  cap test can prove the contents were never pulled into memory. */
function selectFile(text: string, size = new TextEncoder().encode(text).byteLength) {
  const read = vi.fn(async () => text);
  Object.defineProperty($('file'), 'files', {
    value: [{ size, text: read }],
    configurable: true,
  });
  return read;
}

/**
 * Give a whole open — four key derivations and one decryption per record —
 * room to run to completion.
 *
 * A wall-clock wait, deliberately generous, because the tests that use it
 * assert that nothing happened: too short a wait would turn «the page stayed
 * closed» into «the open had not got there yet». The POSITIVE CONTROL below
 * runs the same container through the same wait and requires it to be open by
 * the end, so the budget can never rot into meaninglessness unnoticed.
 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1000));
}

async function clickOpen(seed = MNEMONIC): Promise<void> {
  $<HTMLTextAreaElement>('seed').value = seed;
  $<HTMLButtonElement>('open').click();
  // The handler is fire-and-forget and does real crypto: wait for it to settle
  // rather than guessing a number of microtasks.
  await vi.waitFor(() => {
    expect($('view').hidden === false || status() !== 'Открываем…').toBe(true);
  });
}

beforeEach(async () => {
  document.body.innerHTML = BODY;
  clicks.length = 0;
  vi.resetModules();
  await import('./main');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// jsdom implements neither, and both are load-bearing here: the download path
// and the two confirmations are exactly what these tests are about.
vi.stubGlobal('confirm', vi.fn(() => true));
Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:stub'), configurable: true });
Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
  value: function (this: HTMLAnchorElement) { clicks.push(this.download); },
  configurable: true,
});

describe('the size cap is a fact about the FILE (D17)', () => {
  it('refuses a file past the cap WITHOUT reading it', async () => {
    // Materializing a 40 MB container to discover it is too large is the tab
    // dying on a phone, not an error message.
    const read = selectFile('irrelevant', BACKUP_CAP_BYTES + 1);

    await clickOpen();

    expect(read).not.toHaveBeenCalled();
    expect(status()).toContain('32 МБ');
    expect($('view').hidden).toBe(true);
  });

  it('opens a file that fits', async () => {
    selectFile(await container({ notes: [await makeNote()] }));
    await clickOpen();
    expect($('view').hidden).toBe(false);
  });
});

describe('failures are typed, and say different things', () => {
  it('a container from a newer app is not called damaged', async () => {
    // The one place a user has no second source of advice. «Damaged or wrong
    // seed» would send them hunting for a broken file instead of a newer
    // viewer — and the file is perfectly fine.
    const honest = JSON.parse(await container({ notes: [await makeNote()] })) as Record<string, unknown>;
    selectFile(JSON.stringify({ ...honest, minReaderVersion: 2 }));

    await clickOpen();

    expect(status()).toContain('более новой версией');
    expect(status()).not.toContain('seed');
  });

  it('a file that is not a container at all says so', async () => {
    selectFile('not json at all');
    await clickOpen();
    expect(status()).toContain('не похоже на файл резервной копии');
  });

  it('damaged bytes and a wrong seed share ONE message, because they are indistinguishable', async () => {
    const parsed = JSON.parse(await container({ notes: [await makeNote()] })) as {
      body: { ciphertext: string };
    };
    const bytes = Uint8Array.from(atob(parsed.body.ciphertext), c => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    parsed.body.ciphertext = bufferToBase64(bytes);
    selectFile(JSON.stringify(parsed));

    await clickOpen();

    expect(status()).toContain('другой seed-фразой');
  });

  it('the three messages are actually different', async () => {
    const seen = new Set<string>();
    const honest = JSON.parse(await container({ notes: [await makeNote()] })) as Record<string, unknown>;

    for (const text of [
      JSON.stringify({ ...honest, minReaderVersion: 2 }),
      'not json at all',
      JSON.stringify({ ...honest, body: { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' } }),
    ]) {
      document.body.innerHTML = BODY;
      vi.resetModules();
      await import('./main');
      selectFile(text);
      await clickOpen();
      seen.add(status());
    }

    expect(seen.size).toBe(3);
  });
});

describe('the compatibility flag is judged asymmetrically (D11a)', () => {
  it('a header claiming unsupported records shows NO warning when everything reads', async () => {
    // «Часть записей (0) не может быть показана» is worse than no warning: it
    // is a warning the user cannot act on, about a file this viewer just
    // showed in full.
    selectFile(await container({ notes: [await makeNote()], containsUnsupportedRecords: true }));

    await clickOpen();

    expect($('view').hidden).toBe(false);
    expect($('view-warnings').textContent ?? '').not.toContain('Часть записей');
  });

  it('a header denying them while they are present fails CLOSED', async () => {
    const opaque = { ...(await makeNote()), v: 9 } as unknown as EncryptedNote;
    selectFile(await container({ notes: [opaque], containsUnsupportedRecords: false }));

    await clickOpen();

    expect($('view').hidden).toBe(true);
    expect(status()).toContain('повреждён');
  });

  it('an unreadable VERSION and damaged BYTES are counted apart', async () => {
    const opaque = { ...(await makeNote()), v: 9 } as unknown as EncryptedNote;
    const healthy = await makeNote();
    const damagedNote = await makeNote('gone');
    const damaged = { ...damagedNote, ciphertext: `${damagedNote.ciphertext.slice(0, -4)}AAAA` };
    selectFile(await container({
      notes: [opaque, healthy, damaged],
      containsUnsupportedRecords: true,
    }));

    await clickOpen();

    const warnings = $('view-warnings').textContent ?? '';
    // Different problems, different advice: a newer viewer helps with one and
    // is useless for the other.
    expect(warnings).toContain('Часть записей (1)');
    expect(warnings).toContain('Повреждённых записей: 1');
  });
});

describe('attachments (D22)', () => {
  beforeEach(async () => {
    selectFile(await container({ safebox: [await makeEntry()] }));
    await clickOpen();
  });

  const saveButtons = () => Array.from(document.querySelectorAll('#safebox button'))
    .filter(b => b.textContent === 'сохранить файл') as HTMLButtonElement[];

  it('saving one takes the SAME two confirmations as the bulk export', async () => {
    const ask = vi.mocked(globalThis.confirm);

    ask.mockReturnValueOnce(false);
    saveButtons()[0].click();
    expect(clicks).toEqual([]); // refused at the first question

    ask.mockReturnValueOnce(true).mockReturnValueOnce(false);
    saveButtons()[0].click();
    expect(clicks).toEqual([]); // refused at the second

    ask.mockReturnValue(true);
    saveButtons()[0].click();
    expect(clicks).toEqual(['a.txt']);
    expect(ask).toHaveBeenCalledTimes(5);
  });

  it('the plain-text notes export asks nothing — it carries no secrets', () => {
    const ask = vi.mocked(globalThis.confirm);
    ask.mockClear();
    $('export-notes').click();
    expect(ask).not.toHaveBeenCalled();
    expect(clicks).toEqual(['eternal-notes.txt']);
  });
});

describe('contents are bound to their descriptor by fid, never by position', () => {
  it('a permuted secret half still saves each file under its own name', async () => {
    // The envelope contract binds the halves one to one BY FID and says
    // nothing about order (crypto.ts). Pairing by index would hand the user
    // one secret under another secret's name.
    const { pairAttachments } = await import('./main');
    const descriptors = [
      { fid: FID_A, name: 'a.txt', mime: 'text/plain', size: SECRETS.fileA.length },
      { fid: FID_B, name: 'b.txt', mime: 'text/plain', size: SECRETS.fileB.length },
    ];
    const contents = [
      { fid: FID_B, data: btoa(SECRETS.fileB) },
      { fid: FID_A, data: btoa(SECRETS.fileA) },
    ];

    const paired = pairAttachments(descriptors, contents);

    const decoded = paired.map(f => new TextDecoder().decode(f.bytes));
    expect(decoded).toEqual([SECRETS.fileA, SECRETS.fileB]);
    expect(paired.map(f => f.name)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('leaving the page tears the vault down, DOM included', () => {
  async function openAndReveal(): Promise<void> {
    selectFile(await container({ notes: [await makeNote()], safebox: [await makeEntry()] }));
    await clickOpen();
    const reveal = Array.from(document.querySelectorAll('#safebox button'))
      .find(b => b.textContent === 'показать') as HTMLButtonElement;
    reveal.click();
  }

  it('a revealed password really is in the document first', async () => {
    await openAndReveal();
    expect(document.body.textContent).toContain(SECRETS.password);
    expect(document.body.textContent).toContain(SECRETS.noteText);
  });

  it('`pagehide` removes every secret from the document, synchronously', async () => {
    await openAndReveal();

    window.dispatchEvent(new Event('pagehide'));

    // No awaits between the event and these assertions on purpose: BFCache
    // snapshots the document when the handler returns, so anything cleared
    // «soon» would be cleared too late.
    const left = document.body.textContent ?? '';
    for (const secret of Object.values(SECRETS)) expect(left).not.toContain(secret);
    expect($('notes').childElementCount).toBe(0);
    expect($('safebox').childElementCount).toBe(0);
    expect($('summary').textContent).toBe('');
    expect($('view').hidden).toBe(true);
    expect($('entry').hidden).toBe(false);
  });

  it('the seed phrase and the chosen file go with it', async () => {
    await openAndReveal();
    expect($<HTMLTextAreaElement>('seed').value).not.toBe('');

    window.dispatchEvent(new Event('pagehide'));

    expect($<HTMLTextAreaElement>('seed').value).toBe('');
    expect($<HTMLInputElement>('file').value).toBe('');
  });

  it('a page restored from BFCache comes back CLOSED', async () => {
    await openAndReveal();

    // A restore that skipped the teardown — or took its snapshot before it —
    // would otherwise put the whole vault back on screen with no seed phrase
    // asked for.
    const restored = new Event('pageshow') as Event & { persisted: boolean };
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);

    expect(document.body.textContent).not.toContain(SECRETS.password);
    expect($('view').hidden).toBe(true);
    expect($('entry').hidden).toBe(false);
  });

  it('nothing can be exported after the teardown', async () => {
    await openAndReveal();
    window.dispatchEvent(new Event('pagehide'));
    clicks.length = 0;

    $('export-notes').click();
    $('export-secrets').click();

    expect(clicks).toEqual([]);
  });
});

describe('an open still in flight cannot reopen a closed page', () => {
  /** A file whose read happens WHILE the page is being torn down — the window
   *  BFCache freezes a pending open in. */
  function fileThatClosesThePage(text: string, closeIt: () => void) {
    Object.defineProperty($('file'), 'files', {
      value: [{ size: new TextEncoder().encode(text).byteLength, text: async () => { closeIt(); return text; } }],
      configurable: true,
    });
  }

  it('a teardown DURING the open wins — the vault is not repainted afterwards', async () => {
    // Without a generation guard the frozen continuation resumes after the
    // teardown, re-assigns the state and repaints every note and password onto
    // a page that was just declared closed — with no seed phrase asked for and
    // every export path live again.
    const text = await container({ notes: [await makeNote()], safebox: [await makeEntry()] });
    fileThatClosesThePage(text, () => window.dispatchEvent(new Event('pagehide')));

    $<HTMLTextAreaElement>('seed').value = MNEMONIC;
    $<HTMLButtonElement>('open').click();
    await settle();

    expect($('view').hidden).toBe(true);
    expect($('notes').childElementCount).toBe(0);
    expect(document.body.textContent).not.toContain(SECRETS.password);
    expect(document.body.textContent).not.toContain(SECRETS.noteText);
    // ...and no message about a file that is perfectly fine.
    expect(status()).toBe('');
  });

  it('POSITIVE CONTROL: the same file, the same wait, no teardown — it opens', async () => {
    // Proves the assertion above is not just «the open had not finished yet».
    const text = await container({ notes: [await makeNote()], safebox: [await makeEntry()] });
    fileThatClosesThePage(text, () => { /* nothing closes the page this time */ });

    $<HTMLTextAreaElement>('seed').value = MNEMONIC;
    $<HTMLButtonElement>('open').click();
    await settle();

    expect($('view').hidden).toBe(false);
    expect(document.body.textContent).toContain(SECRETS.noteText);
  });

  it('a BFCache restore during an open also wins', async () => {
    const text = await container({ notes: [await makeNote()] });
    fileThatClosesThePage(text, () => {
      window.dispatchEvent(new Event('pagehide'));
      const restored = new Event('pageshow') as Event & { persisted: boolean };
      Object.defineProperty(restored, 'persisted', { value: true });
      window.dispatchEvent(restored);
    });

    $<HTMLTextAreaElement>('seed').value = MNEMONIC;
    $<HTMLButtonElement>('open').click();
    await settle();

    expect($('view').hidden).toBe(true);
    expect(document.body.textContent).not.toContain(SECRETS.noteText);
  });
});

describe('the seed phrase is normalized the way the app normalizes it', () => {
  it('a phrase in wallet casing opens the file', async () => {
    // Wallets and printed recovery cards capitalize; the BIP-39 wordlist is
    // lower-case only, and the app lower-cases at its seed grid. Without the
    // same rule here a correct phrase derives a different key IN SILENCE and
    // the user is told their only backup may be damaged.
    selectFile(await container({ notes: [await makeNote()] }));
    await clickOpen(MNEMONIC.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '));
    expect($('view').hidden).toBe(false);
  });

  it('a phrase wrapped over several lines opens the file', async () => {
    // BIP-39 counts words by single spaces and throws on anything else — the
    // page had not read a byte of the container before that throw.
    selectFile(await container({ notes: [await makeNote()] }));
    await clickOpen(MNEMONIC.replace(/ /g, '\n  '));
    expect($('view').hidden).toBe(false);
  });

  it('a phrase that is not BIP-39 at all blames the PHRASE, not the file', async () => {
    selectFile(await container({ notes: [await makeNote()] }));
    await clickOpen('это вообще не seed-фраза');

    expect(status()).toContain('Проверьте seed-фразу');
    expect(status()).not.toContain('повреждён');
  });

  it('a valid-but-different phrase still blames the file-or-seed pair, honestly', async () => {
    // Here the two really are indistinguishable: GCM cannot tell a wrong key
    // from damaged bytes, and the phrase itself is beyond reproach.
    selectFile(await container({ notes: [await makeNote()] }));
    await clickOpen('legal winner thank year wave sausage worth useful legal winner thank yellow');

    expect(status()).toContain('другой seed-фразой');
  });
});

describe('what is shown is the CURRENT version of each record', () => {
  async function noteChain(): Promise<EncryptedNote[]> {
    const key = await deriveKey(MNEMONIC);
    const first = await encryptEnvelopeV3(key, 'the ORIGINAL text', { fmt: 'plain', rev: 1 });
    const second = await encryptEnvelopeV3(key, 'an intermediate edit', {
      fmt: 'plain', rev: 2, root: first.noteId, prev: first.noteId,
    });
    const third = await encryptEnvelopeV3(key, SECRETS.noteText, {
      fmt: 'plain', rev: 3, root: first.noteId, prev: second.noteId,
    });
    return [first, second, third];
  }

  it('three versions of one note are ONE card, showing the newest text', async () => {
    // The container carries every version the store held. Rendering them flat
    // puts old text beside current text with nothing to tell them apart — and
    // in the safebox that means an expired password looking exactly as
    // authoritative as the live one.
    selectFile(await container({ notes: await noteChain() }));
    await clickOpen();

    expect($('notes').childElementCount).toBe(1);
    expect($('notes').textContent).toContain(SECRETS.noteText);
    expect($('notes').textContent).not.toContain('the ORIGINAL text');
  });

  it('the summary counts what is shown AND says how many versions the file holds', async () => {
    // Two numbers that disagree are fine as long as the line explains both:
    // the record count is what «is this copy whole» is answered from, and it
    // is not the number of cards.
    selectFile(await container({ notes: await noteChain() }));
    await clickOpen();

    expect($('summary').textContent).toContain('1 заметок');
    expect($('summary').textContent).toContain('всего версий в файле: 3');
  });

  it('a safebox entry shows the CURRENT password, not a superseded one', async () => {
    const metaKey = await deriveSafeboxMetaKey(MNEMONIC);
    const secretKey = await deriveSafeboxSecretKey(MNEMONIC);
    const first = await encryptSafeboxEntry(metaKey, secretKey, {
      title: SECRETS.title, login: '', url: '', note: '',
      password: 'OLD-PASSWORD-THAT-NO-LONGER-WORKS', files: [], rev: 1,
    });
    const second = await encryptSafeboxEntry(metaKey, secretKey, {
      title: SECRETS.title, login: '', url: '', note: '',
      password: SECRETS.password, files: [], rev: 2, root: first.entryId, prev: first.entryId,
    });

    selectFile(await container({ safebox: [first, second] }));
    await clickOpen();

    expect($('safebox').childElementCount).toBe(1);
    const reveal = document.querySelector('#safebox button') as HTMLButtonElement;
    reveal.click();
    expect($('safebox').textContent).toContain(SECRETS.password);
    expect($('safebox').textContent).not.toContain('OLD-PASSWORD-THAT-NO-LONGER-WORKS');
  });
});

describe('the blocking warning is actually delivered', () => {
  it('carries role="alert" so it is announced, not just present', async () => {
    // D11a calls this warning blocking. A paragraph the user is never scrolled
    // to and never told about is a paragraph, not a block — and what it stands
    // between is the user and deleting the files they cannot rebuild from.
    selectFile(await container({ notes: [await makeNote()], incompleteRestore: true }));
    await clickOpen();

    const first = $('view-warnings').firstElementChild;
    expect(first?.getAttribute('role')).toBe('alert');
    expect(first?.textContent).toContain('заведомо неполна');
  });

  it('an ordinary open leaves no warning to announce', async () => {
    selectFile(await container({ notes: [await makeNote()] }));
    await clickOpen();
    expect($('view-warnings').childElementCount).toBe(0);
  });
});
