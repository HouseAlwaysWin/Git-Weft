/**
 * Branch folders: where names fold, where they do not, and which folding a list of names asks for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { foldRefs, foldingFor } from '../src/git/refFolders.ts';
import type { Folded, Folding } from '../src/git/refFolders.ts';

/** The folded tree as text: a folder with its path, its children indented beneath it. */
function draw(nodes: readonly Folded<string>[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'leaf'
      ? [`${'  '.repeat(depth)}${node.label}`]
      : [`${'  '.repeat(depth)}${node.label} (${node.path})`, ...draw(node.children, depth + 1)],
  );
}

const fold = (names: string[], folding: Folding, strip = ''): string[] =>
  draw(foldRefs(names, (name) => name, folding, strip));

test('slashes fold at every level, and only two names or more make a folder', () => {
  assert.deepEqual(fold(['feature/a', 'feature/b', 'release/v1', 'main', 'fix/deep/one', 'fix/deep/two'], 'slash'), [
    'feature/ (feature/)',
    '  a',
    '  b',
    'release/v1',
    'main',
    'fix/ (fix/)',
    '  deep/ (fix/deep/)',
    '    one',
    '    two',
  ]);
});

test('an underscore folds once, at the first one, and the leaf keeps the rest', () => {
  assert.deepEqual(fold(['Dev_ACR080VN_ERP-10147', 'Dev_B2_ERP-1', 'Fix_C3', 'Feat_only'], 'slashAndUnderscore'), [
    'Dev_ (Dev_)',
    '  ACR080VN_ERP-10147',
    '  B2_ERP-1',
    'Fix_C3',
    'Feat_only',
  ]);
});

test('an underscore at either end is no prefix, and case is part of the name', () => {
  assert.deepEqual(fold(['_x', '_y', 'z_', 'Dev_a', 'dev_b'], 'slashAndUnderscore'), ['_x', '_y', 'z_', 'Dev_a', 'dev_b']);
});

test('slashes first, then the underscore in the last part', () => {
  assert.deepEqual(fold(['team/Dev_a', 'team/Dev_b', 'team/Fix_c'], 'slashAndUnderscore'), [
    'team/ (team/)',
    '  Dev_ (team/Dev_)',
    '    a',
    '    b',
    '  Fix_c',
  ]);
});

test('one remote is read without its name', () => {
  assert.deepEqual(fold(['origin/Dev_a', 'origin/Dev_b', 'origin/main'], 'slashAndUnderscore', 'origin/'), [
    'Dev_ (Dev_)',
    '  a',
    '  b',
    'main',
  ]);
});

test('none folds nothing', () => {
  assert.deepEqual(fold(['feature/a', 'feature/b'], 'none'), ['feature/a', 'feature/b']);
});

test('auto folds on the underscore only when more names use it than a slash', () => {
  assert.equal(foldingFor(['Dev_a', 'Fix_b', 'feature/c'], 'auto'), 'slashAndUnderscore');
  assert.equal(foldingFor(['feature/a', 'fix/b', 'Dev_c'], 'auto'), 'slash');
  assert.equal(foldingFor(['main'], 'auto'), 'slash');
  assert.equal(foldingFor(['Dev_a'], 'none'), 'none');
});
