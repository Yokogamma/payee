import { describe, it, expect } from 'vitest';

/**
 * What the RUNTIME accepts, asserted against the runtime itself.
 *
 * `redirect: 'error'` is valid in a browser and refused by workerd, which
 * throws a TypeError while parsing init — before any I/O, on every call. The
 * worker shipped with it in both gateway readers (D9 and the status probe),
 * and the entire suite stayed green: every stub ignored `init`, so nothing
 * ever evaluated the option. Production could not read a single gateway,
 * `getTxStatusWorker` was pinned at `unavailable`, and every legacy record
 * answered 503 `legacy_unproven`.
 *
 * This file exists so the constraint is stated where it cannot be mocked away.
 * It sends nothing: the throw happens before the request is made, which is
 * exactly the property being pinned. `example.invalid` is unresolvable by
 * design (RFC 2606) so a regression cannot quietly reach the network either.
 */
describe('workerd fetch: redirect modes', () => {
  it('refuses `error` before any I/O — never reintroduce it', async () => {
    await expect(
      fetch('https://example.invalid/', { redirect: 'error' as RequestRedirect }),
    ).rejects.toThrow(/Invalid redirect value/);
  });

  it('accepts `manual`, the mode the gateway readers must use', () => {
    // Constructing the Request is enough: init parsing is where `error` dies,
    // so a mode that survives construction is a mode fetch will accept.
    expect(() => new Request('https://example.invalid/', { redirect: 'manual' })).not.toThrow();
    expect(new Request('https://example.invalid/', { redirect: 'manual' }).redirect).toBe('manual');
  });
});
