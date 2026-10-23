import { createHash } from 'node:crypto';

// A short, one-way identifier for a secret: enough to tell keys apart,
// useless for recovering the key itself.
export function fingerprint(value) {
  return 'fp:' + createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}
