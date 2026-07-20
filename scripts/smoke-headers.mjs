/**
 * Post-deploy smoke test: fetch a deployed URL and assert the security headers
 * are actually applied (they are NOT on GitHub Pages — this verifies the
 * Cloudflare Pages cutover really took effect).
 *
 * Usage: node scripts/smoke-headers.mjs https://your-app.pages.dev
 */
const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/smoke-headers.mjs <deployed-url>');
  process.exit(2);
}

const required = {
  'content-security-policy': /default-src 'self'/,
  'x-frame-options': /DENY/i,
  'x-content-type-options': /nosniff/i,
  'referrer-policy': /strict-origin-when-cross-origin/i,
};

const res = await fetch(url, { redirect: 'manual' });
const problems = [];
for (const [name, pattern] of Object.entries(required)) {
  const value = res.headers.get(name);
  if (!value) problems.push(`missing ${name}`);
  else if (!pattern.test(value)) problems.push(`${name} = "${value}" (expected ${pattern})`);
}

if (problems.length) {
  console.error(`smoke-headers FAILED for ${url}:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`smoke-headers OK for ${url}: CSP + XFO + nosniff + Referrer-Policy present`);
