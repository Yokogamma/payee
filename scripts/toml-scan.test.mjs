import { describe, it, expect } from 'vitest';
import { readTomlString, TomlScanError } from './toml-scan.mjs';

describe('readTomlString — the happy shape wrangler.toml actually uses', () => {
  const toml = `
name = "eternal-notes-proxy"

[vars]
ALLOWED_ORIGINS = "https://notes.example"
UPLOADS_ENABLED = "true"

[env.staging]
name = "staging"

[env.staging.vars]
UPLOADS_ENABLED = "false"
`;
  it('reads a key from the root and from nested tables', () => {
    expect(readTomlString(toml, '', 'name').value).toBe('eternal-notes-proxy');
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
    expect(readTomlString(toml, 'env.staging.vars', 'UPLOADS_ENABLED').value).toBe('false');
  });

  it('reports a missing key or table instead of guessing', () => {
    expect(readTomlString(toml, 'vars', 'NOPE').error).toMatch(/missing NOPE/);
    expect(readTomlString(toml, 'absent', 'X').error).toMatch(/missing table/);
  });
});

// ── The bypasses a substring search allows ────────────────────────────────
describe('hostile inputs', () => {
  it('IGNORES a decoy table hidden in a multi-line string', () => {
    // `indexOf('[vars]')` finds the decoy FIRST and reads "false", while
    // wrangler reads the real table and uploads stay on.
    const toml = `
[define]
NOTE = """
[vars]
UPLOADS_ENABLED = "false"
"""

[vars]
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  it('ignores a decoy inside a single-quoted multi-line string', () => {
    const toml = `
[define]
NOTE = '''
[vars]
UPLOADS_ENABLED = "false"
'''

[vars]
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  it('ignores a commented-out table header and a commented key', () => {
    const toml = `
# [vars]
# UPLOADS_ENABLED = "false"

[vars]
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  // Refusing beats merging: which of the two wrangler honours is not something
  // this scanner should have an opinion about.
  it('REFUSES a duplicated table rather than picking one', () => {
    const toml = `
[vars]
UPLOADS_ENABLED = "true"

[vars]
UPLOADS_ENABLED = "false"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').error).toMatch(/declared 2 times/);
  });

  it('REFUSES a duplicated key inside one table', () => {
    const toml = `
[vars]
UPLOADS_ENABLED = "true"
UPLOADS_ENABLED = "false"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').error).toMatch(/declared twice/);
  });

  it('REFUSES a non-string value rather than coercing it', () => {
    expect(readTomlString('[vars]\nUPLOADS_ENABLED = true\n', 'vars', 'UPLOADS_ENABLED').error)
      .toMatch(/not a basic string/);
    expect(readTomlString('[vars]\nX = ["a"]\n', 'vars', 'X').error).toMatch(/not a basic string/);
  });

  it('REFUSES an unterminated multi-line string', () => {
    expect(() => readTomlString('[define]\nX = """\nopen forever\n', 'vars', 'Y'))
      .toThrow(/unterminated/);
  });

  it('does not confuse a table header appearing INSIDE a value', () => {
    const toml = `
[vars]
NOTE = "see [vars] for details"
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  it('tolerates a trailing comment after a value', () => {
    expect(readTomlString('[vars]\nX = "y" # why\n', 'vars', 'X').value).toBe('y');
  });

  it('handles [[array.tables]] headers without treating them as the same table', () => {
    const toml = `
[[kv_namespaces]]
binding = "A"

[vars]
X = "y"
`;
    expect(readTomlString(toml, 'vars', 'X').value).toBe('y');
  });
});

describe('quoted and dotted spellings are REFUSED, not skipped', () => {
  // wrangler reads every one of these as the bare table/key the gates look
  // for. A scanner that only understood the bare spelling and ignored the rest
  // would let a candidate put the REAL value where the gate never looks.
  const cases = {
    'quoted table name': '["vars"]\nTRUSTED_OWNERS = "x"\n',
    'quoted segment in a dotted header': '[env."staging".vars]\nTRUSTED_OWNERS = "x"\n',
    'escaped quoted segment': '[env."sta\\"ging".vars]\nTRUSTED_OWNERS = "x"\n',
    'quoted key': '[vars]\n"TRUSTED_OWNERS" = "x"\n',
    'dotted key': 'vars.TRUSTED_OWNERS = "x"\n',
    'space inside a header segment': '[va rs]\nTRUSTED_OWNERS = "x"\n',
    'a line that is neither header nor assignment': '[vars]\njust some words\n',
  };
  for (const [label, toml] of Object.entries(cases)) {
    it(`refuses: ${label}`, () => {
      expect(() => readTomlString(toml, 'vars', 'TRUSTED_OWNERS')).toThrow(TomlScanError);
    });
  }

  it('a decoy bare [vars] next to the quoted real one is refused, not read', () => {
    // The precise attack: the gate sees a safe bare table; wrangler merges the
    // quoted one over it. Refusing the file is the only answer that cannot be
    // gamed.
    const toml = '[vars]\nUPLOADS_ENABLED = "false"\n["vars"]\nUPLOADS_ENABLED = "true"\n';
    expect(() => readTomlString(toml, 'vars', 'UPLOADS_ENABLED')).toThrow(TomlScanError);
  });
});

describe('the shapes wrangler.toml legitimately uses still scan', () => {
  it('multi-line arrays of inline tables are continuation lines, not refusals', () => {
    const toml = [
      '[durable_objects]',
      'bindings = [',
      '  { name = "RATE_LIMITER", class_name = "RateLimiter" },',
      '  { name = "IP_RATE_LIMITER", class_name = "IpRateLimiter" }',
      ']',
      '',
      '[vars]',
      'TRUSTED_OWNERS = "x" # trailing comment',
    ].join('\n');
    expect(readTomlString(toml, 'vars', 'TRUSTED_OWNERS')).toEqual({ value: 'x' });
  });

  it('a bracket inside a string does not open an array', () => {
    const toml = '[vars]\nA = "[not an array"\nTRUSTED_OWNERS = "x"\n';
    expect(readTomlString(toml, 'vars', 'TRUSTED_OWNERS')).toEqual({ value: 'x' });
  });

  it('an unbalanced array is refused rather than swallowing the rest of the file', () => {
    const toml = '[vars]\nA = [\n  1,\n[env.staging.vars]\nTRUSTED_OWNERS = "x"\n';
    expect(() => readTomlString(toml, 'env.staging.vars', 'TRUSTED_OWNERS')).toThrow(TomlScanError);
  });

  it('the shipped worker/wrangler.toml scans in full', async () => {
    const { readFileSync } = await import('node:fs');
    const real = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
    expect(readTomlString(real, 'vars', 'TRUSTED_OWNERS').value).toBeTruthy();
    expect(readTomlString(real, 'env.staging.vars', 'PAYLOAD_GATEWAYS').value).toBeTruthy();
  });
});
