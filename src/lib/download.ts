/**
 * Handing a file to the browser.
 *
 * One function because the subtlety is worth stating once: the object URL must
 * be revoked on a LATER task. A synchronous revoke after `click()` aborts the
 * download in several browsers, and the failure is silent — the user gets
 * nothing and no error. Everything else here is ordinary.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function saveText(text: string, fileName: string, mime: string): void {
  saveBlob(new Blob([text], { type: `${mime};charset=utf-8` }), fileName);
}
