/**
 * Clipboard write that reports TRUTHFULLY. navigator.clipboard.writeText can
 * reject (no permission, insecure context, platform quirks); pretending it
 * succeeded is harmless for a note but dangerous for the seed phrase — the
 * user may believe a backup exists that was never made.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('clipboard write failed:', err);
    return false;
  }
}
