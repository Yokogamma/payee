import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyTextToClipboard } from './clipboard';

afterEach(() => vi.unstubAllGlobals());

describe('copyTextToClipboard (honest result)', () => {
  it('returns true when the clipboard write resolves', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyTextToClipboard('seed words')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('seed words');
  });

  it('returns false when the clipboard write REJECTS — never a false success', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('NotAllowedError'); }) },
    });
    expect(await copyTextToClipboard('seed words')).toBe(false);
  });

  it('returns false when the clipboard API is missing entirely', async () => {
    vi.stubGlobal('navigator', {});
    expect(await copyTextToClipboard('x')).toBe(false);
  });
});
