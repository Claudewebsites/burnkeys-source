import { execFileSync } from 'node:child_process';
import { identify } from './providers.js';
import { fingerprint } from './fingerprint.js';

const realClipboard = {
  read: () => execFileSync('pbpaste', { encoding: 'utf8' }).trim(),
  clear: () => execFileSync('pbcopy', { input: '' }),
};

// Take a key from the clipboard and clear it. With `wait`, keep watching until
// a NEW key appears (so a key that was already sitting in the clipboard is never
// used by mistake) - the user only has to click "Copy" on the provider's site.
export async function takeKeyFromClipboard({ wait = false, timeoutMs = 5 * 60_000, pollMs = 700, clipboard = realClipboard, log = () => {}, shouldStop = () => false, accept } = {}) {
  const read = () => { try { return clipboard.read(); } catch { return ''; } };
  const isKey = (v) => !!v && !/[\r\n]/.test(v) && (accept ? accept(v) : !!identify('', v));
  const take = (v) => { try { clipboard.clear(); } catch { /* ignore */ } return v; };

  if (!wait) {
    const v = read();
    return isKey(v) ? take(v) : '';
  }
  const before = read();
  const beforeFp = before ? fingerprint(before) : null;
  log('Waiting for you to copy the new key on the provider\'s site...');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !shouldStop()) {
    await new Promise((r) => setTimeout(r, pollMs));
    const v = read();
    if (isKey(v) && fingerprint(v) !== beforeFp) return take(v);
  }
  log('Timed out waiting for a new key in the clipboard.');
  return '';
}
