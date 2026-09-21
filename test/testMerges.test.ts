/**
 * Merges that took a test site's branch somewhere else: which messages say so, which say the opposite,
 * and what the setting holds that can be used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PATCH_ID_ARGS,
  branchChoices,
  findTestMerges,
  mergedBranch,
  parseMerges,
  parsePatchIds,
  parsePicked,
  patchesArgs,
  pickedArgs,
  pickedByOneAuthor,
  readTestBranches,
  refsFor,
  remotesIn,
  splitBranchNames,
  tookTestBranch,
} from '../src/git/testMerges.ts';

const NUL = '\x00';

test('a merge message says which branch was merged, and into what', () => {
  // Every shape seen in a repository of 35,996 merges, and the one GitLab writes, which quotes both.
  assert.deepEqual(mergedBranch("Merge branch 'uat'"), { branch: 'uat', into: null });
  assert.deepEqual(mergedBranch("Merge branch 'uat' into Dev_Thing"), { branch: 'uat', into: 'Dev_Thing' });
  assert.deepEqual(mergedBranch("Merge branch 'uat' of http://host/group/repo into Dev_Thing"), {
    branch: 'uat',
    into: 'Dev_Thing',
  });
  assert.deepEqual(mergedBranch("Merge remote-tracking branch 'origin/uat' into Dev_Thing"), {
    branch: 'origin/uat',
    into: 'Dev_Thing',
  });
  assert.deepEqual(mergedBranch("Merge branch 'uat' into 'uat_deploy'"), { branch: 'uat', into: 'uat_deploy' });

  // An octopus names no single branch, and a pull request's own wording is not git's.
  assert.equal(mergedBranch("Merge branches 'a' and 'b'"), null);
  assert.equal(mergedBranch('Merge pull request #12 from someone/uat'), null);
  assert.equal(mergedBranch('Fix the total for ERP-10147'), null);
});

test('only merges that took a test branch elsewhere are reported, and a pull on it is not one', () => {
  const merges = parseMerges(
    [
      `aaa1${NUL}Eagle${NUL}1758000000${NUL}Merge branch 'uat' of http://host/group/repo into Dev_Thing`,
      `bbb2${NUL}Cathy${NUL}1757000000${NUL}Merge branch 'uat' of http://host/group/repo into uat`,
      `ccc3${NUL}Winni${NUL}1756000000${NUL}Merge branch 'Dev_Thing' into uat`,
      `ddd4${NUL}Zeke${NUL}1755000000${NUL}Merge remote-tracking branch 'origin/sit' into Feat_Other`,
      `eee5${NUL}Max${NUL}1754000000${NUL}Merge branch 'release/v1.3' into Dev_Thing`,
      `fff6${NUL}Rui${NUL}1753000000${NUL}Merge branch 'uat_deploy' into Dev_Thing`,
      '',
    ].join('\n'),
  );

  assert.equal(merges.length, 6, 'every record was read');

  const found = findTestMerges(merges, ['uat', 'sit'], new Set(['aaa1']));

  /*
   * What is left out is the point of this. `bbb2` is a pull on the test branch itself, of which there
   * were two thousand in the repository this was measured on; `ccc3` is the ordinary way round, a
   * feature going to the test site; `eee5` is the trunk coming the other way; and `fff6` is a branch
   * whose name begins with a test branch's and is not one.
   */
  assert.deepEqual(
    found.map((merge) => `${merge.sha} ${merge.branch} -> ${merge.into} ${merge.landed ? 'landed' : 'not yet'}`),
    ['aaa1 uat -> Dev_Thing landed', 'ddd4 sit -> Feat_Other not yet'],
  );
});

test('the setting holds branch names, and nothing else', () => {
  assert.deepEqual(readTestBranches(['uat', ' sit ', '', 42, null, 'origin/staging']), [
    'uat',
    'sit',
    'origin/staging',
  ]);
  assert.deepEqual(readTestBranches('uat'), []);
  assert.deepEqual(readTestBranches(undefined), []);
});

test('the branches offered are the ones there are, under the name the setting wants', () => {
  const offered = branchChoices(
    [
      'refs/heads/main',
      'refs/heads/uat',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/uat',
      'refs/remotes/origin/sit',
      'refs/remotes/upstream/release/v1.3',
      '',
    ].join('\n'),
  );

  /*
   * `origin/uat` is offered as `uat` - the name that matches both - and only once, though two refs have
   * it. A branch with a slash in its name keeps the slash; only the remote is taken off the front.
   */
  assert.deepEqual(offered, ['main', 'release/v1.3', 'sit', 'uat']);
  assert.deepEqual(branchChoices(''), []);
});

test('one merge at a time, which is what the graph asks of every merge it walks', () => {
  const names = ['uat', 'sit'];

  assert.deepEqual(tookTestBranch("Merge branch 'uat' into Dev_Thing", names), { branch: 'uat', into: 'Dev_Thing' });
  assert.deepEqual(tookTestBranch("Merge remote-tracking branch 'origin/sit' into Dev_Thing", names), {
    branch: 'sit',
    into: 'Dev_Thing',
  });

  // The two that look like it: a pull on the test branch, and a feature going the ordinary way round.
  assert.equal(tookTestBranch("Merge branch 'uat' of http://host/group/repo into uat", names), null);
  assert.equal(tookTestBranch("Merge branch 'Dev_Thing' into uat", names), null);
  assert.equal(tookTestBranch('Fix the total for ERP-10147', names), null);

  // And nothing is a test branch when nothing is named, which is the switch being off.
  assert.equal(tookTestBranch("Merge branch 'uat' into Dev_Thing", []), null);
});

test('a box of branch names is read as a list', () => {
  assert.deepEqual(splitBranchNames('uat, sit'), ['uat', 'sit']);
  assert.deepEqual(splitBranchNames('  uat '), ['uat']);
  assert.deepEqual(splitBranchNames('uat,,'), ['uat']);
  assert.deepEqual(splitBranchNames('  '), []);
});

test('a cherry-marked walk names the commits with a copy on the other side, and who wrote them', () => {
  const NUL = '\x00';

  assert.deepEqual(pickedArgs('HEAD', 'refs/remotes/origin/uat', 'left'), [
    'log',
    '--left-only',
    '--cherry-mark',
    '--format=%m%x00%H%x00%an',
    'HEAD...refs/remotes/origin/uat',
  ]);

  // The other side is read for one thing and is never drawn: who wrote the twin.
  assert.equal(pickedArgs('HEAD', 'refs/remotes/origin/uat', 'right')[1], '--right-only');

  /*
   * `=` is a commit with a copy on the other side. The walk is asked for one side, so what comes back is
   * what that history holds - the copy, not the commit it was copied from, which are two shas.
   */
  assert.deepEqual(
    parsePicked(
      [`=${NUL}aaa1${NUL}Ann`, `<${NUL}bbb2${NUL}Bob`, `>${NUL}ccc3${NUL}Cal`, `=${NUL}ddd4${NUL}Dee`, ''].join('\n'),
    ),
    [
      { sha: 'aaa1', author: 'Ann' },
      { sha: 'ddd4', author: 'Dee' },
    ],
  );
  assert.deepEqual(parsePicked(''), []);
});

test('the same change by two different hands is not a copy either of them made', () => {
  assert.deepEqual(patchesArgs(), ['log', '--stdin', '--no-walk', '-p', '--format=%H']);
  assert.deepEqual(PATCH_ID_ARGS, ['patch-id', '--stable']);
  assert.deepEqual(
    parsePatchIds(['p1 aaa1', 'p2 bbb2', '', '  p3 ccc3  '].join('\n')),
    new Map([
      ['aaa1', 'p1'],
      ['bbb2', 'p2'],
      ['ccc3', 'p3'],
    ]),
  );

  const mine = [
    // A cherry-pick: the picker becomes the committer, so the author is still the one over there.
    { sha: 'copy', author: 'Ann' },
    // The version bump, which matched the same bump made months earlier by somebody else.
    { sha: 'bump', author: 'Nick' },
    // Marked as having a twin, but the twin was not among what was read.
    { sha: 'lone', author: 'Ann' },
  ];
  const theirs = [
    { sha: 'theOriginal', author: 'Ann' },
    { sha: 'theirBump', author: 'Winni' },
  ];
  const ids = new Map([
    ['copy', 'p1'],
    ['theOriginal', 'p1'],
    ['bump', 'p2'],
    ['theirBump', 'p2'],
    ['lone', 'p3'],
  ]);

  assert.deepEqual(pickedByOneAuthor(mine, theirs, ids), ['copy']);

  // And nothing from over there comes back, whatever it is paired with.
  assert.deepEqual(pickedByOneAuthor([], theirs, ids), []);
});

test('a name in the box means every branch of that name, local first', () => {
  const refs = [
    'refs/heads/main',
    'refs/heads/uat',
    'refs/remotes/origin/uat',
    'refs/remotes/mirror/uat',
    'refs/remotes/origin/sit',
    'refs/tags/uat',
  ];

  /*
   * Both, and in that order. A test site is deployed from a server, so the remote's copy is what says
   * what is on it - and the local copy is a snapshot from whenever somebody last fetched. On the
   * repository this was measured against, those two disagreed by 251 commits and each found changes the
   * other did not.
   */
  assert.deepEqual(refsFor('uat', refs), [
    'refs/heads/uat',
    'refs/remotes/origin/uat',
    'refs/remotes/mirror/uat',
  ]);
  assert.deepEqual(refsFor('sit', refs), ['refs/remotes/origin/sit'], 'a remote one with no local copy');
  assert.deepEqual(refsFor('nothing', refs), []);

  // A tag of the same name is not a branch to have taken anything from.
  assert.deepEqual(refsFor('uat', ['refs/tags/uat']), []);
});

test('the remotes are read off the refs, once each and in the order they appear', () => {
  assert.deepEqual(
    remotesIn([
      'refs/heads/main',
      'refs/remotes/origin/main',
      'refs/remotes/origin/uat',
      'refs/remotes/mirror/main',
      'refs/tags/v1.0',
    ]),
    ['origin', 'mirror'],
  );

  assert.deepEqual(remotesIn(['refs/heads/main']), [], 'a repository with no remote has none');
});
