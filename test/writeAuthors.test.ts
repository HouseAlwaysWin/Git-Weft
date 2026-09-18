/**
 * Who wrote what: spellings folded into people, and the groups made by hand.
 *
 * One of the files `test/write.test.ts` was split into - see `writeSupport.ts` for why, and for
 * everything they have in common.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAuthors, listAuthors, readGroupAssignments } from '../src/git/authors.ts';
import type { Author } from '../src/git/authors.ts';

import { commitAs, git, made, makeRepo, open, walk } from './writeSupport.ts';

test('one row per name, however many addresses that name has committed from', async () => {
  const dir = makeRepo();

  commitAs(dir, 'jiaying_wu', 'jia@laptop.invalid', 'one.txt');
  commitAs(dir, 'jiaying_wu', 'jia@build.invalid', 'two.txt');
  commitAs(dir, 'jiaying_wu', 'jia@build.invalid', 'three.txt');

  const listed = groupAuthors(await listAuthors(git, await open(dir)));
  const jia = listed.filter((author) => author.name === 'jiaying_wu');

  assert.equal(jia.length, 1, 'one row, not one per address');
  assert.equal(jia[0]?.commits, 3, 'and the count is all of them together');
  assert.deepEqual(
    [...(jia[0]?.emails ?? [])].sort(),
    ['jia@build.invalid', 'jia@laptop.invalid'],
    'both addresses are kept, so the row can say why the number is what it is',
  );
  assert.deepEqual(
    jia[0]?.members.map((member) => member.name),
    ['jiaying_wu'],
    'one spelling, so one name to filter by',
  );
});

test('spellings that differ only in case or separators are one person, and all are kept', async () => {
  const dir = makeRepo();

  commitAs(dir, 'sean_lin', 'sean@example.invalid', 'lower.txt');
  commitAs(dir, 'Sean Lin', 'sean@work.invalid', 'spaced1.txt');
  commitAs(dir, 'Sean Lin', 'sean@work.invalid', 'spaced2.txt');
  commitAs(dir, 'SEAN_LIN', 'sean@example.invalid', 'shouty.txt');

  const sean = (groupAuthors(await listAuthors(git, await open(dir)))).filter(
    (author) => author.name.toLowerCase().replace('_', ' ') === 'sean lin',
  );

  assert.equal(sean.length, 1, 'one row, not one per spelling');
  assert.equal(sean[0]?.commits, 4);
  assert.equal(sean[0]?.name, 'Sean Lin', 'shown as whichever spelling has the most behind it');
  assert.deepEqual(
    (sean[0]?.members ?? []).map((member) => member.name).sort(),
    ['SEAN_LIN', 'Sean Lin', 'sean_lin'],
    'all three are kept, or a tick walks a fraction of what the row counted',
  );
  assert.deepEqual([...(sean[0]?.emails ?? [])].sort(), ['sean@example.invalid', 'sean@work.invalid']);
});

test('a group made by hand joins spellings the rule will not', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Lineric', 'lin@example.invalid', 'short.txt');
  commitAs(dir, 'lineric_lin', 'lin@example.invalid', 'long.txt');

  const identities = await listAuthors(git, await open(dir));
  const custom = new Map([['Lineric', ['Lineric Lin']], ['lineric_lin', ['Lineric Lin']]]);

  const grouped = groupAuthors(identities, custom).filter((author) => author.custom);

  assert.equal(grouped.length, 1, 'one person, not two');
  assert.equal(grouped[0]?.name, 'Lineric Lin', 'and it is called what it was named');
  assert.deepEqual(
    (grouped[0]?.members ?? []).map((member) => member.name).sort(),
    ['Lineric', 'lineric_lin'],
    'with both spellings kept, because --author still needs each of them',
  );
});

test('one person can be in more than one group at a time', async () => {
  /*
   * Somebody is on the platform team and on the release rota, and a list that makes them pick one
   * is not describing the place they work. So a spelling carries as many group names as it needs
   * and is listed under each of them.
   *
   * Which means the counts overlap: both rows count the same commits, because both rows would walk
   * them. The alternative is a row whose number no tick of it would produce.
   */
  const dir = makeRepo();

  commitAs(dir, 'Winni_Lee', 'winni@example.invalid', 'a.txt');
  commitAs(dir, 'Wei_Pan', 'wei@example.invalid', 'b.txt');

  const identities = await listAuthors(git, await open(dir));

  const grouped = groupAuthors(
    identities,
    new Map([
      ['Winni_Lee', ['Platform', 'Release Rota']],
      ['Wei_Pan', ['Platform']],
    ]),
  );

  const platform = grouped.find((author) => author.name === 'Platform');
  const rota = grouped.find((author) => author.name === 'Release Rota');

  assert.deepEqual(
    (platform?.members ?? []).map((member) => member.name).sort(),
    ['Wei_Pan', 'Winni_Lee'],
    'the team has both of them',
  );

  assert.deepEqual(
    (rota?.members ?? []).map((member) => member.name),
    ['Winni_Lee'],
    'and the rota has the one who is on it',
  );

  // Listed where they were put, and nowhere else: an assignment replaces what the rule would have
  // done with a spelling rather than adding to it, or grouping anybody would list them twice.
  assert.equal(
    grouped.filter((author) => author.members.some((member) => member.name === 'Winni_Lee')).length,
    2,
    'in exactly the two groups they were put in',
  );

  assert.equal(
    (platform?.commits ?? 0) + (rota?.commits ?? 0) > (platform?.commits ?? 0),
    true,
    'and both rows count the commits they would walk, overlap included',
  );
});

test('a group named twice over is one group, not two', async () => {
  // The same fold that makes `Sean Lin` and `sean_lin` one person: a group is named by a person,
  // and people do not type a name the same way twice.
  const dir = makeRepo();

  commitAs(dir, 'Gaga_Liu', 'gaga@example.invalid', 'a.txt');
  commitAs(dir, 'Corey_Lai', 'corey@example.invalid', 'b.txt');

  const identities = await listAuthors(git, await open(dir));

  const grouped = groupAuthors(
    identities,
    new Map([
      ['Gaga_Liu', ['Backend']],
      ['Corey_Lai', ['backend']],
    ]),
  );

  const backend = grouped.filter((author) => author.custom);

  assert.equal(backend.length, 1, 'one row, whichever way it was typed');
  assert.equal(backend[0]?.members.length, 2);
});

test('the rule can be told it was wrong about two spellings', async () => {
  /*
   * It folds by case and separators, which is right nine times in ten: `Max_Chiue` and
   * `max_chiue` are one person who configured git on two machines. The tenth time they are two
   * people, and the list had no way of being told - the group the rule made offered nothing but
   * "add to a group", and adding both to one would have said the opposite of what was meant.
   *
   * No groups at all is the third answer, and it is not the same as no assignment: no assignment
   * means "the rule decides", and the rule is exactly what is being overruled.
   */
  const dir = makeRepo();

  commitAs(dir, 'Max_Chiue', 'max@example.invalid', 'upper.txt');
  commitAs(dir, 'max_chiue', 'max@example.invalid', 'lower.txt');

  const identities = await listAuthors(git, await open(dir));
  const named = (list: readonly Author[]): Author[] =>
    list.filter((one) => one.name.toLowerCase() === 'max_chiue');

  assert.equal(named(groupAuthors(identities)).length, 1, 'the rule folds them to begin with');

  const apart = groupAuthors(
    identities,
    new Map<string, string[]>([
      ['Max_Chiue', []],
      ['max_chiue', []],
    ]),
  );

  assert.equal(named(apart).length, 2, 'and comes apart when it is told to');
  assert.deepEqual(named(apart).map((one) => one.members.length), [1, 1]);

  assert.ok(
    named(apart).every((one) => !one.custom),
    'kept apart by hand is not the same as put together by hand, and the row should not say it is',
  );

  // One of the two, for the group of four where three of them really are the same person.
  const one = groupAuthors(identities, new Map<string, string[]>([['max_chiue', []]]));

  assert.equal(named(one).length, 2, 'taking one spelling out leaves the rest folded');

  // And back: an empty entry is an override, and removing an override restores what was underneath.
  assert.equal(named(groupAuthors(identities, new Map())).length, 1);
});

test('the groups remembered by an older version are still read', async () => {
  /*
   * A spelling used to be in one group, and one group was stored as one string. Reading the old
   * shape as if it were the new one gives a group per letter - so it is read as what it is, and
   * nobody loses the grouping they did last week.
   */
  assert.deepEqual(
    [...readGroupAssignments({ Lineric: 'Lineric Lin', lineric_lin: 'Lineric Lin' })],
    [
      ['Lineric', ['Lineric Lin']],
      ['lineric_lin', ['Lineric Lin']],
    ],
  );

  assert.deepEqual(
    [...readGroupAssignments({ Winni_Lee: ['Platform', 'Release Rota'] })],
    [['Winni_Lee', ['Platform', 'Release Rota']]],
  );

  assert.deepEqual([...readGroupAssignments({})], []);
});

test('a group made by hand can take a spelling back out of one the rule made', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Max_Chiue', 'max@example.invalid', 'upper.txt');
  commitAs(dir, 'max_chiue', 'max@example.invalid', 'lower.txt');

  const identities = await listAuthors(git, await open(dir));

  assert.equal(
    groupAuthors(identities).filter((a) => a.name.toLowerCase() === 'max_chiue').length,
    1,
    'the rule puts them together',
  );

  const apart = groupAuthors(identities, new Map([['max_chiue', ['Somebody Else']]]));

  assert.deepEqual(
    apart.filter((a) => a.members.some((m) => m.name.toLowerCase() === 'max_chiue')).map((a) => a.name).sort(),
    ['Max_Chiue', 'Somebody Else'],
    'and naming one of them separately takes it back out',
  );
});

test('names differing by more than case and separators are left alone', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Lineric', 'lin@example.invalid', 'short.txt');
  commitAs(dir, 'lineric_lin', 'lin@example.invalid', 'long.txt');

  const names = (groupAuthors(await listAuthors(git, await open(dir)))).map((author) => author.name);

  assert.ok(names.includes('Lineric'));
  assert.ok(names.includes('lineric_lin'));
});

test('a shared address does not merge the people using it', async () => {
  const dir = makeRepo();

  commitAs(dir, 'Deploy Bot', 'admin@example.invalid', 'deployed.txt');
  commitAs(dir, 'Administrator', 'admin@example.invalid', 'administered.txt');

  const names = (groupAuthors(await listAuthors(git, await open(dir)))).map((author) => author.name);

  assert.ok(names.includes('Deploy Bot'));
  assert.ok(names.includes('Administrator'));
});

test('the author list comes back busiest first, after the folding has moved names about', async () => {
  const dir = makeRepo();

  commitAs(dir, 'busy', 'a@example.invalid', 'a1.txt');
  commitAs(dir, 'busy', 'b@example.invalid', 'a2.txt');
  commitAs(dir, 'busy', 'c@example.invalid', 'a3.txt');
  commitAs(dir, 'quiet', 'd@example.invalid', 'b1.txt');

  const counts = (groupAuthors(await listAuthors(git, await open(dir)))).map((author) => author.commits);

  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a),
    'three ones folded into a three has to be sorted again, or it sits where the one sat',
  );
});
