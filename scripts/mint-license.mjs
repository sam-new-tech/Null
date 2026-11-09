#!/usr/bin/env node
/**
 * License mint for Null (seller-side tool — never ships in the app).
 *
 * Retail model: `new` prints a sellable key. The FIRST device that activates
 * it locks it (key + device hash stored on-device, re-verified every launch).
 * Any other device computing a different binding fails — sharing stops at the
 * first activation. Reinstalls get a new device id: issue a replacement key.
 *
 * The pepper lives in .env.local (EXPO_PUBLIC_LICENSE_PEPPER) and must ALSO
 * reach EAS builds, e.g.:
 *   npx eas-cli secret:create --name EXPO_PUBLIC_LICENSE_PEPPER \
 *     --value "$(grep EXPO_PUBLIC_LICENSE_PEPPER .env.local | cut -d= -f2)" \
 *     --type string
 * Never commit or share the pepper — anyone holding it can mint keys that
 * pass app-side validation.
 *
 * Usage:
 *   node scripts/mint-license.mjs new   # sellable key, track it as sold
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

const rand = (n) => Array.from(randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const group = (s) => (s.match(/.{1,4}/g) ?? []).join('-');

const [, , cmd] = process.argv;
if (cmd === 'new') {
  console.log(`NULL-${group(rand(12))}`);
} else {
  console.error('usage: new');
  process.exit(1);
}
