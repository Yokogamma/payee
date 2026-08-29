import { describe, it, expect } from 'vitest';
import { checkUploadSwitchesOff } from './check-gateways-vs-worker.mjs';

const toml = (prod, staging) => `
[vars]
ALLOWED_ORIGINS = "https://notes.example"
UPLOADS_ENABLED = "${prod.uploads}"
V3_UPLOADS_ENABLED = "${prod.v3}"
V4_UPLOADS_ENABLED = "${prod.v4}"

[env.staging]
name = "staging"

[env.staging.vars]
UPLOADS_ENABLED = "${staging.uploads}"
V3_UPLOADS_ENABLED = "${staging.v3}"
V4_UPLOADS_ENABLED = "${staging.v4}"
`;
const OFF = { uploads: 'false', v3: 'false', v4: 'false' };
const ON = { uploads: 'true', v3: 'true', v4: 'true' };

describe('emergency preflight — block-scoped, never a file-wide grep', () => {
  it('passes when the PRODUCTION table has all three off', () => {
    expect(checkUploadSwitchesOff(toml(OFF, ON), '')).toEqual({ ok: true, problems: [] });
  });

  // THE bug this exists for: a file-wide grep would find the staging "false"
  // lines and wave through a production config with uploads ON.
  it('fails when production is ON even though staging is OFF', () => {
    const { ok, problems } = checkUploadSwitchesOff(toml(ON, OFF), '');
    expect(ok).toBe(false);
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toMatch(/UPLOADS_ENABLED is "true"/);
  });

  it('fails when only ONE switch is left on', () => {
    const { ok, problems } = checkUploadSwitchesOff(toml({ ...OFF, v4: 'true' }, OFF), '');
    expect(ok).toBe(false);
    expect(problems.join(' ')).toMatch(/V4_UPLOADS_ENABLED is "true"/);
  });

  it('reports a missing key rather than treating absence as off', () => {
    const partial = '[vars]\nUPLOADS_ENABLED = "false"\n';
    const { ok, problems } = checkUploadSwitchesOff(partial, '');
    expect(ok).toBe(false);
    expect(problems.join(' ')).toMatch(/missing V3_UPLOADS_ENABLED/);
  });

  it('can be pointed at the staging block explicitly', () => {
    expect(checkUploadSwitchesOff(toml(ON, OFF), 'env.staging.').ok).toBe(true);
  });
});
