import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchBackupViewer,
  ViewerDeliveryError,
  BACKUP_VIEWER_FILE_NAME,
  BACKUP_VIEWER_PATH,
} from './viewer-delivery';
import * as hashModule from './backup-viewer-hash';

/**
 * Handing over the viewer, and the one claim that hand-off is allowed to make.
 *
 * The digest closes the DELIVERY channel and nothing else. These tests pin
 * both halves of that: bytes that do not match are not saved, and a build with
 * no reference digest refuses rather than presenting an unchecked download as
 * a verified one.
 */

const VIEWER = '<!doctype html><title>viewer</title>';
const DIGEST = 'c0ffee'.repeat(10) + 'abcd';

const deps = (over: Partial<Parameters<typeof fetchBackupViewer>[0]> = {}) => ({
  fetch: vi.fn(async () => new Response(VIEWER, { status: 200 })) as unknown as typeof globalThis.fetch,
  sha256Hex: async () => DIGEST,
  baseUrl: '/',
  ...over,
});

beforeEach(() => {
  vi.spyOn(hashModule, 'BACKUP_VIEWER_HASH_IS_PLACEHOLDER', 'get').mockReturnValue(false);
  vi.spyOn(hashModule, 'BACKUP_VIEWER_SHA256', 'get').mockReturnValue(DIGEST);
});

describe('a build without a reference digest refuses', () => {
  it('does not fetch at all', async () => {
    // Fail-closed on a clean checkout: with nothing to compare against, a
    // download offered as verified would be a claim nobody checked.
    vi.spyOn(hashModule, 'BACKUP_VIEWER_HASH_IS_PLACEHOLDER', 'get').mockReturnValue(true);
    const d = deps();

    await expect(fetchBackupViewer(d)).rejects.toMatchObject({ reason: 'not_built' });
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe('the canonical URL', () => {
  it('is extensionless, under the app base', async () => {
    const d = deps({ baseUrl: '/app/' });
    await fetchBackupViewer(d);

    expect(vi.mocked(d.fetch).mock.calls[0][0]).toBe(`/app/${BACKUP_VIEWER_PATH}`);
    expect(BACKUP_VIEWER_PATH).not.toContain('.html');
  });

  it('asks for fresh bytes — a cached copy is a copy nobody checked today', async () => {
    const d = deps();
    await fetchBackupViewer(d);
    expect(vi.mocked(d.fetch).mock.calls[0][1]).toEqual({ cache: 'no-store' });
  });
});

describe('what comes back', () => {
  it('is returned with its verified digest when it matches', async () => {
    const delivered = await fetchBackupViewer(deps());

    expect(delivered).toEqual({ text: VIEWER, fileName: BACKUP_VIEWER_FILE_NAME, sha256: DIGEST });
  });

  it('is refused when the digest differs', async () => {
    const error = await fetchBackupViewer(deps({ sha256Hex: async () => 'deadbeef' }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ViewerDeliveryError);
    expect(error).toMatchObject({ reason: 'hash_mismatch' });
    expect((error as Error).message).toContain('не сохранён');
  });

  it('a non-200 is «unavailable», not a mismatch', async () => {
    // Different advice: one means try again later, the other means do not
    // trust what arrived. A 404 reported as a mismatch would send the user
    // looking for an attacker.
    const d = deps({
      fetch: vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof globalThis.fetch,
    });

    await expect(fetchBackupViewer(d)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('an offline failure is «unavailable» too', async () => {
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch,
    });

    await expect(fetchBackupViewer(d)).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
