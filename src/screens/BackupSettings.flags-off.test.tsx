// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));

import { BackupSettings } from './BackupSettings';
import { backupActions } from '../lib/backup-ui';
import { BACKUP_EXPORT_ENABLED, BACKUP_IMPORT_ENABLED } from '../lib/flags';

/**
 * The build as it ships — real flags, both off (release 1).
 *
 * The state §7 calls client-floor, and the reason it gets its own file: with
 * the flags off the block is ABSENT, not disabled and not greyed. That
 * includes the viewer instruction, which is the part someone would keep out of
 * sympathy — «at least tell them about the viewer». Asking a user to download
 * a companion for a feature the interface does not offer is worse than
 * silence: there is nothing yet for the companion to open.
 */

afterEach(cleanup);

describe('the shipped flag pair', () => {
  it('is the release-1 pair: both off', () => {
    expect(BACKUP_EXPORT_ENABLED).toBe(false);
    expect(BACKUP_IMPORT_ENABLED).toBe(false);
  });

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
