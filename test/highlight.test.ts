import test from 'node:test';
import assert from 'node:assert/strict';

import type { Search } from '../src/git/search.ts';
import { marking, same } from '../src/webview/highlight.ts';

/** A search as the box would build one: a query, a mode, and every switch off. */
function search(query: string, mode: Search['mode'] = 'message', options: Partial<Search> = {}): Search {
  return {
    query,
    mode,
    caseSensitive: false,
    regex: false,
    allTerms: false,
    invert: false,
    follow: false,
    ...options,
  };
}

/** What a marking would actually mark in a piece of text. */
function hits(pattern: RegExp | null, text: string): string[] {
  if (pattern === null) {
    return [];
  }

  pattern.lastIndex = 0;

  return [...text.matchAll(pattern)].map((match) => match[0]);
}

test('a plain query marks the subject, and marks it as text', () => {
  const { pattern, field } = marking(search('lane'));

  assert.equal(field, 'subject');
  assert.deepEqual(hits(pattern, 'Interleave the lane points'), ['lane']);
});

test('author mode marks the author column instead', () => {
  const { pattern, field } = marking(search('Ada', 'author'));

  assert.equal(field, 'author');
  assert.deepEqual(hits(pattern, 'Ada Fischer'), ['Ada']);
});

/*
 * The one that was wrong. The pattern for `lane` is identical in both modes, so a repaint decided
 * on the pattern alone never happened - and the marks stayed on the subject while the search had
 * moved to the author. Two markings that paint different columns are not the same marking.
 */
test('the same query in two modes is not the same marking', () => {
  const onMessage = marking(search('lane'));
  const onAuthor = marking(search('lane', 'author'));

  assert.equal(onMessage.pattern?.source, onAuthor.pattern?.source);
  assert.equal(same(onMessage, onAuthor), false);
});

test('a marking is the same as itself, rebuilt', () => {
  assert.equal(same(marking(search('lane')), marking(search('lane'))), true);
  assert.equal(same(marking(search('lane')), marking(search('lanes'))), false);
  assert.equal(
    same(marking(search('lane')), marking(search('lane', 'message', { caseSensitive: true }))),
    false,
  );
});

test('the modes whose match is not on a row mark nothing', () => {
  for (const mode of ['committer', 'content', 'path'] as const) {
    const { pattern, field } = marking(search('lane', mode));

    assert.equal(field, null, `${mode} claimed a column`);
    assert.equal(pattern, null, `${mode} built a pattern`);
  }
});

test('an inverted search marks nothing, because every row on screen missed', () => {
  assert.deepEqual(marking(search('lane', 'message', { invert: true })), { pattern: null, field: null });
});

test('nothing in the box marks nothing', () => {
  assert.deepEqual(marking(null), { pattern: null, field: null });
  assert.deepEqual(marking(search('   ')), { pattern: null, field: null });
});

test('text mode escapes what a regular expression would read as syntax', () => {
  const { pattern } = marking(search('v0.4.1'));

  assert.deepEqual(hits(pattern, 'tag v0.4.1 shipped'), ['v0.4.1']);
  assert.deepEqual(hits(pattern, 'tag v0X4Y1 shipped'), []);
});

test('the regex switch turns that back on', () => {
  const { pattern } = marking(search('a.a', 'message', { regex: true }));

  assert.deepEqual(hits(pattern, 'separators'), ['ara']);
});

test('a pattern JavaScript cannot parse turns the marking off, not the search', () => {
  assert.deepEqual(marking(search('a(', 'message', { regex: true })), { pattern: null, field: null });
});

test('case follows the switch', () => {
  assert.deepEqual(hits(marking(search('LANE')).pattern, 'the lane points'), ['lane']);
  assert.deepEqual(
    hits(marking(search('LANE', 'message', { caseSensitive: true })).pattern, 'the lane points'),
    [],
  );
});

/*
 * `allTerms` is only offered in message mode, and the marking has to honour the same table the
 * buttons come from: splitting the query on words in a mode where git was never asked to would be
 * the marking claiming a match git did not make.
 */
test('every-word splits the query only where git was asked to', () => {
  const split = marking(search('lane points', 'message', { allTerms: true }));

  assert.deepEqual(hits(split.pattern, 'Interleave the lane points'), ['lane', 'points']);

  const whole = marking(search('Ada Fischer', 'author', { allTerms: true }));

  assert.deepEqual(hits(whole.pattern, 'Ada Fischer'), ['Ada Fischer']);
  assert.deepEqual(hits(whole.pattern, 'Ada Berg'), []);
});
