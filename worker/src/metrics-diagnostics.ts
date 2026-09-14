/** Allowlisted upstream diagnostics. Never copy messages, bodies, URLs or headers. */
export function metricsErrorCodes(text: string | null): number[] {
  if (text === null) return [];
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return []; }
  if (typeof doc !== 'object' || doc === null || !('errors' in doc) || !Array.isArray(doc.errors)) return [];
  return [...new Set(doc.errors.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('code' in entry)) return [];
    return typeof entry.code === 'number' && Number.isSafeInteger(entry.code) && entry.code >= 0
      ? [entry.code] : [];
  }))].slice(0, 8);
}

/** CF-Ray is untrusted input too: accept only its documented structural shape. */
export function metricsRay(value: string | null): string | undefined {
  return value !== null && /^[a-fA-F0-9]{16}(?:-[A-Z]{3})?$/.test(value) ? value : undefined;
}
