/**
 * Ticket ids as links: which configured links are used, when a clicked id opens and where, and where
 * ids are found in a text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findTickets, readTicketLinks, ticketUrl } from '../src/git/ticketLinks.ts';

const ERP = { pattern: 'ERP-[0-9]+', url: 'https://tracker.example/browse/$0' };

test('only links with a pattern that compiles and a web address are used, and the rest are named', () => {
  const read = readTicketLinks([
    ERP,
    { pattern: 'EVIL-[0-9]+', url: 'file:///C:/Windows/System32/calc.exe' },
    { pattern: '([', url: 'https://tracker.example/$0' },
    { pattern: '', url: 'https://tracker.example/$0' },
    { pattern: 'X', url: 42 },
    'ERP',
    null,
  ]);

  assert.deepEqual(read.links, [ERP]);

  /*
   * Each entry that was turned down, in the order it was written, said in enough words to find it in
   * a settings file. The first two are the ones the manifest's own schema cannot catch, which is the
   * reason any of this is reported rather than dropped.
   */
  assert.deepEqual(
    read.unusable.map((bad) => bad.why.replace(/:.*/s, '')),
    [
      'its url is not http or https',
      'its pattern is not a regular expression',
      'its pattern is empty',
      'it has no url',
      'it is not a pattern and a url',
      'it is not a pattern and a url',
    ],
  );

  assert.equal(read.unusable[0]?.entry, JSON.stringify({ pattern: 'EVIL-[0-9]+', url: 'file:///C:/Windows/System32/calc.exe' }));
  assert.match(read.unusable[1]?.why ?? '', /Invalid regular expression|SyntaxError|character class/);

  assert.deepEqual(readTicketLinks('not a list'), { links: [], unusable: [] });
});

test('an id opens only when it matches whole, and what goes into the address is encoded', () => {
  const links = [ERP, { pattern: '([A-Z]+)#([0-9]+)', url: 'https://tracker.example/$1/issues/$2' }];

  assert.equal(ticketUrl(links, 'ERP-10147'), 'https://tracker.example/browse/ERP-10147');
  assert.equal(ticketUrl(links, 'WEFT#12'), 'https://tracker.example/WEFT/issues/12');
  assert.equal(ticketUrl(links, 'see ERP-10147'), null);
  assert.equal(ticketUrl(links, 'ERP-1/../../x'), null);
  assert.equal(
    ticketUrl([{ pattern: '.+', url: 'https://tracker.example/q?id=$0' }], 'a b&c'),
    'https://tracker.example/q?id=a%20b%26c',
  );
});

test('ids are found as words, an underscore separating them', () => {
  const text = 'Fix ERP-10147, ERP-2 and not XERP-3 or ERP-4a';
  const words = findTickets(['ERP-[0-9]+'], text).map(([start, end]) => text.slice(start, end));

  assert.deepEqual(words, ['ERP-10147', 'ERP-2']);

  const branch = 'Dev_ACR080VN_ERP-10147';
  assert.deepEqual(
    findTickets(['ERP-[0-9]+'], branch).map(([start, end]) => branch.slice(start, end)),
    ['ERP-10147'],
  );

  assert.deepEqual(findTickets(['(['], 'ERP-1'), [], 'a pattern that does not compile finds nothing');
});
