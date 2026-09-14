/**
 * A failure about a lock file, told as what it is when the lock is an old one.
 *
 * git takes a lock by creating a file beside the one it is about to change - `config.lock` beside
 * `config` - and renames it over the original when it is done. A git command that stops part-way leaves
 * the lock behind, and from then on every write to that file fails as though another command were in the
 * middle of it. The error mapping, which has only git's words to go on, said exactly that: wait for the
 * other git process, and try again. With nothing running, the wait never ends - a repository went eight
 * months with a config.lock nobody knew was there, and no setting in it could be changed.
 *
 * So the lock's age is looked at, which words alone cannot tell. A lock older than any command runs is
 * named, with when it was left and that deleting it is the fix. Weft does not delete it: a lock that old
 * is almost certainly abandoned, and "almost" is no reason to remove a file from somebody's .git.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { MappedError } from './errors.ts';
import { Remedy, lockNamed, staleLockMessage } from './errors.ts';

/** `mapped`, unless git failed on a lock that has been there too long to be anybody's work in progress. */
export async function explainStaleLock(mapped: MappedError, root: string, now: Date = new Date()): Promise<MappedError> {
  const named = lockNamed(mapped.raw);

  if (named === null) {
    return mapped;
  }

  const path = isAbsolute(named) ? named : join(root, named);
  const since = await stat(path).then(
    (file) => file.mtime,
    () => null,
  );

  if (since === null) {
    return mapped;
  }

  const message = staleLockMessage(relative(root, path).split(sep).join('/'), since, now);

  return message === null ? mapped : { ...mapped, message, remedies: [Remedy.ShowLog] };
}
