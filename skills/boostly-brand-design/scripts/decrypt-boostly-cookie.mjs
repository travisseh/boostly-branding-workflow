#!/usr/bin/env node
// Decrypt a Chrome-profile cookie jar into a raw Cookie header file for the
// boostly-instore-link-settings CLI. macOS only (Chrome Safe Storage keychain).
//
// Usage:
//   node decrypt-boostly-cookie.mjs [--profile "Profile 10"] [--host new.boostly.com] --out <file>
//
// Security contract: NEVER print cookie values. Output file is chmod 0600.
// The keychain read may prompt the user once — that is expected.
//
// Chrome cookie encryption (v10/v11, macOS): AES-128-CBC, key =
// PBKDF2-SHA1(keychain "Chrome Safe Storage" password, 'saltysalt', 1003 iters, 16 bytes),
// IV = 16 spaces. Chrome 130+ prepends sha256(host_key) (32 bytes) to the plaintext.

import { execSync } from 'node:child_process';
import { pbkdf2Sync, createDecipheriv, createHash } from 'node:crypto';
import { writeFileSync, chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const profile = opt('profile', process.env.BOOSTLY_CHROME_PROFILE || 'Profile 10');
const host = opt('host', 'new.boostly.com');
const outFile = opt('out', null);
if (!outFile) {
  console.error('Usage: decrypt-boostly-cookie.mjs [--profile "Profile 10"] [--host new.boostly.com] --out <file>');
  process.exit(2);
}

const cookiesDb = join(
  process.env.HOME,
  'Library/Application Support/Google/Chrome',
  profile,
  'Cookies',
);

// Copy the db first — Chrome holds a lock on the live file.
const tmp = mkdtempSync(join(tmpdir(), 'ck-'));
const dbCopy = join(tmp, 'Cookies.db');
copyFileSync(cookiesDb, dbCopy);

const pass = execSync('security find-generic-password -w -s "Chrome Safe Storage"')
  .toString()
  .trim();
const key = pbkdf2Sync(pass, 'saltysalt', 1003, 16, 'sha1');
const iv = Buffer.alloc(16, ' ');

const rows = execSync(
  `sqlite3 ${JSON.stringify(dbCopy)} "SELECT name || '|' || hex(encrypted_value) FROM cookies WHERE host_key='${host}';"`,
)
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);

function decrypt(hex, hostKey) {
  const enc = Buffer.from(hex, 'hex');
  const prefix = enc.slice(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  const d = createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
  const hostHash = createHash('sha256').update(hostKey).digest();
  if (out.length >= 32 && out.slice(0, 32).equals(hostHash)) out = out.slice(32);
  return out.toString('utf8');
}

const pairs = [];
for (const line of rows) {
  const i = line.indexOf('|');
  const name = line.slice(0, i);
  const val = decrypt(line.slice(i + 1), host);
  if (val === null) {
    console.error(`skip ${name} (unsupported encryption prefix)`);
    continue;
  }
  pairs.push(`${name}=${val}`);
  console.error(`ok ${name} (${val.length} chars)`); // names + lengths only, never values
}

rmSync(tmp, { recursive: true, force: true });

if (!pairs.length) {
  console.error(`No decryptable cookies for host ${host} in ${profile}. Log in to ${host} in that Chrome profile first.`);
  process.exit(1);
}

writeFileSync(outFile, pairs.join('; '));
chmodSync(outFile, 0o600);
console.error(`Wrote ${pairs.length} cookies to ${outFile} (0600). Verify with: boostly-links auth check --cookie-file ${outFile} --json`);
