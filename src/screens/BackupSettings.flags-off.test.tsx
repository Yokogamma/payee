// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));
// Release 1 pair, MOCKED since the import flip (release 2): the real file no
// longer ships both off. The shipped pair is asserted in
// `src/lib/flags.shipped.test.ts`; this file keeps the client-floor state
// (both off) under test, because a rollback to `client-b1` is that state.
vi.mock('../lib/flags', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/flags')>()),
  BACKUP_EXPORT_ENABLED: false,
  BACKUP_IMPORT_ENABLED: false,
}));

import { BackupSettings } from './BackupSettings';
import { backupActions } from '../lib/backup-ui';

/**
 * The client-floor build — both flags off (release 1, `client-b1`), the
 * rollback target of every later flip.
 *
 * The state §7 calls client-floor, and the reason it gets its own file: with
 * the flags off the block is ABSENT, not disabled and not greyed. That
 * includes the viewer instruction, which is the part someone would keep out of
 * sympathy — «at least tell them about the viewer». Asking a user to download
 * a companion for a feature the interface does not offer is worse than
 * silence: there is nothing yet for the companion to open.
 */

afterEach(cleanup);

describe('the release-1 flag pair', () => {
  it('offers nothing at all', () => {
    expect(backupActions()).toEqual({ canImport: false, canExport: false, anyVisible: false });
  });
});

describe('with the flags off the block does not exist', () => {
  it('renders nothing — no heading, no instruction, no buttons', () => {
    // The store is deliberately EMPTY: a component that reaches for an action
    // before deciding it has nothing to offer would throw here, which is the
    // failure mode «checked the flag in the markup» produces.
    const { container } = render(<BackupSettings />);

    expect(container.innerHTML).toBe('');
  });
});
