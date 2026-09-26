'use strict';
// Password manager pieces that don't need Electron: CSV import formats and the
// on-disk sanitizer (a hand-edited or corrupt passwords.json can't inject junk).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, sanitizePasswords, cleanOrigin } = require('../src/main/passwords');

test('CSV: Chrome / Google Password Manager export', () => {
  const rows = parseCsv('name,url,username,password,note\r\nornek.com,https://ornek.com/login,ali@ornek.com,"p,a""ss",\r\n');
  assert.deepEqual(rows, [
    ['name', 'url', 'username', 'password', 'note'],
    ['ornek.com', 'https://ornek.com/login', 'ali@ornek.com', 'p,a"ss', '']
  ]);
});

test('CSV: Firefox export (all fields quoted, multi-line value)', () => {
  const rows = parseCsv('"url","username","password"\n"https://a.com","u","line1\nline2"\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][2], 'line1\nline2');
});

test('origins: only http(s), path dropped', () => {
  assert.equal(cleanOrigin('https://Ornek.com/giris?x=1'), 'https://ornek.com');
  assert.equal(cleanOrigin('http://127.0.0.1:8080/a'), 'http://127.0.0.1:8080');
  assert.equal(cleanOrigin('javascript:alert(1)'), null);
  assert.equal(cleanOrigin('file:///C:/x'), null);
  assert.equal(cleanOrigin('not a url'), null);
});

test('sanitizer drops bad entries and keeps good ones', () => {
  const out = sanitizePasswords({
    items: [
      { id: 'p-1', origin: 'https://a.com/x', username: 'u', pw: 'ZW5j', created: 1, updated: 2, used: 0 },
      { id: 'p-2', origin: 'javascript:1', username: 'u', pw: 'x' },
      { id: 'p-3', origin: 'https://b.com', username: 'u' },
      { id: 'p-1', origin: 'https://dup.com', username: 'u', pw: 'x' },
      null
    ],
    never: ['https://c.com/path', 'ftp://d.com', 'https://c.com']
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].origin, 'https://a.com');
  assert.deepEqual(out.never, ['https://c.com']);
});
