import { describe, it, expect } from 'vitest';
import { checkRequiredSecrets, CO_DEPLOY_REGISTRY } from './require-co-deploy-secrets.mjs';

// The «secret required» mode of the worker deploy: the input is parsed
// strictly in trusted code, never by a shell `read` that sees one line.

const present = ['CF_ANALYTICS_TOKEN'];

describe('checkRequiredSecrets', () => {
  it('empty input: nothing required, ordinary deploy', () => {
    expect(checkRequiredSecrets('', present)).toEqual({ ok: true, required: [], problems: [] });
    expect(checkRequiredSecrets(undefined, [])).toEqual({ ok: true, required: [], problems: [] });
  });

  it('a registered name that is present — ok', () => {
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN', present)).toEqual({ ok: true, required: ['CF_ANALYTICS_TOKEN'], problems: [] });
  });

  it('a registered name that is NOT present — refused, naming the secret', () => {
    const r = checkRequiredSecrets('CF_ANALYTICS_TOKEN', []);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/CF_ANALYTICS_TOKEN is not set in the Environment/)]);
  });

  it('an unknown name — refused even if it happens to be present in the file', () => {
    const r = checkRequiredSecrets('ARWEAVE_JWK', ['ARWEAVE_JWK']);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/not in the co-deploy registry/);
  });

  it("a line break — the reviewer's reproduction: refused as a whole, never an empty list", () => {
    const r = checkRequiredSecrets('\nCF_ANALYTICS_TOKEN', present);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/line break/);
    const r2 = checkRequiredSecrets('CF_ANALYTICS_TOKEN\n', present);
    expect(r2.ok).toBe(false);
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN\r\n', present).ok).toBe(false);
  });

  it('an empty element between commas, or a trailing comma — refused', () => {
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN,,CF_ANALYTICS_TOKEN', present).problems.join('\n')).toMatch(/empty element at position 2/);
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN,', present).problems.join('\n')).toMatch(/empty element at position 2/);
    expect(checkRequiredSecrets(',CF_ANALYTICS_TOKEN', present).problems.join('\n')).toMatch(/empty element at position 1/);
  });

  it('whitespace, lower case, duplicates and non-name characters — refused', () => {
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN, CF_ANALYTICS_TOKEN', present).problems.join('\n')).toMatch(/whitespace/);
    expect(checkRequiredSecrets('cf_analytics_token', present).problems.join('\n')).toMatch(/not a secret name/);
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN,CF_ANALYTICS_TOKEN', present).problems.join('\n')).toMatch(/twice/);
    expect(checkRequiredSecrets('$(id)', present).ok).toBe(false);
  });

  it('a malformed present-names list is a refusal, not a pass', () => {
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN', null).ok).toBe(false);
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN', 'CF_ANALYTICS_TOKEN').ok).toBe(false);
  });

  it('the registry is the single list the workflow may require from', () => {
    expect(CO_DEPLOY_REGISTRY).toEqual(['CF_ANALYTICS_TOKEN', 'SPEND_ADMIN_SECRET']);
  });
});

// Runbook reader-release rev. 7, review H2: before the registry knew it, a
// dispatch with required_secrets=SPEND_ADMIN_SECRET was refused as «not in the
// co-deploy registry» — the reader deploy could not carry its own admin key.
describe('SPEND_ADMIN_SECRET (D10 reader) is co-deployable', () => {
  it('required and NOT set in the Environment — refused before the deploy, naming the secret', () => {
    const r = checkRequiredSecrets('SPEND_ADMIN_SECRET', ['CF_ANALYTICS_TOKEN']);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/SPEND_ADMIN_SECRET is not set in the Environment/)]);
    expect(r.problems.join(' ')).not.toMatch(/not in the co-deploy registry/);
  });

  it('required and set — accepted, alone or together with the analytics token', () => {
    expect(checkRequiredSecrets('SPEND_ADMIN_SECRET', ['SPEND_ADMIN_SECRET'])).toEqual({ ok: true, required: ['SPEND_ADMIN_SECRET'], problems: [] });
    expect(checkRequiredSecrets('CF_ANALYTICS_TOKEN,SPEND_ADMIN_SECRET', ['CF_ANALYTICS_TOKEN', 'SPEND_ADMIN_SECRET']).ok).toBe(true);
  });

  it('one of two required missing — refused for that one only', () => {
    const r = checkRequiredSecrets('CF_ANALYTICS_TOKEN,SPEND_ADMIN_SECRET', ['CF_ANALYTICS_TOKEN']);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/SPEND_ADMIN_SECRET is not set/)]);
  });
});
