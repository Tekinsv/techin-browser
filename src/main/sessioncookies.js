'use strict';
// "Continue where you left off" keeps session cookies across restarts, like
// Chrome does: sites remember things like YouTube's theater mode (the `wide`
// session cookie) or a login made without "remember me". Chromium only keeps
// them in memory, so they are written at quit - encrypted with the OS key store
// (DPAPI), never in plain text - and put back (then deleted) at the next start.
const fs = require('node:fs');
const { safeStorage } = require('electron');

const MAX = 4000;

async function saveSessionCookies(ses, file) {
  if (!safeStorage.isEncryptionAvailable()) return 0;
  const all = await ses.cookies.get({});
  const keep = all
    .filter((c) => c.session && typeof c.domain === 'string' && c.domain)
    .slice(0, MAX)
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, hostOnly: !!c.hostOnly, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite }));
  if (!keep.length) {
    forget(file);
    return 0;
  }
  fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(keep)), { mode: 0o600 });
  return keep.length;
}

async function restoreSessionCookies(ses, file) {
  let blob;
  try {
    blob = fs.readFileSync(file);
  } catch {
    return 0;
  }
  forget(file); // one-shot: never restored twice
  let list;
  try {
    list = JSON.parse(safeStorage.decryptString(blob));
  } catch {
    return 0;
  }
  if (!Array.isArray(list)) return 0;
  let n = 0;
  await Promise.all(
    list.slice(0, MAX).map(async (c) => {
      if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') return;
      const host = c.domain.replace(/^\./, '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return;
      const details = { url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
      if (!c.hostOnly) details.domain = c.domain;
      if (['no_restriction', 'lax', 'strict'].includes(c.sameSite)) details.sameSite = c.sameSite;
      try {
        await ses.cookies.set(details); // no expirationDate: stays a session cookie
        n++;
      } catch {}
    })
  );
  return n;
}

function forget(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

module.exports = { saveSessionCookies, restoreSessionCookies, forget };
