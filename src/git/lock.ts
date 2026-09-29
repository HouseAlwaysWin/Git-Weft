/**
 * One writer at a time, per repository.
 *
 * git takes its own locks on the index and on refs, so two writes will not corrupt the object
 * store. What they will do is fail each other in confusing ways - the second command reports
 * `index.lock: File exists`, and the user is left holding an error that describes our concurrency
 * rather than their repository.
 *
 * The lock is also what makes a *sequence* atomic. Almost every action here is really three steps:
 * read the state, decide, act. Without the lock, two actions can both read "the tree is clean" and
 * only one of them still be right by the time it acts.
 *
 * Keyed by the **common directory** - `git rev-parse --git-common-dir` - and not by the working
 * tree, because one repository can have several of those. A linked worktree has its own root, its own
 * index and its own HEAD, and shares everything the queue exists to protect: the refs, the object
 * store, the config. Two roots meant two queues, so a branch being deleted in one tree and checked out
 * in another were free to interleave - and the sequences here are read, decide, act, which is exactly
 * what interleaving breaks. Two different repositories still have nothing to say to each other, and
 * still do not wait for one another: a submodule's common directory is its own.
 */
export class RepoLock {
  /** The tail of each repository's queue; awaiting it means waiting for everything ahead of you. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `work` once every earlier caller for this repository has finished.
   *
   * A failure is contained: the rejection reaches that task's own caller, while the queue itself
   * carries on. Otherwise one failed write would poison every write after it.
   */
  async run<T>(commonDir: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(commonDir) ?? Promise.resolve();
    const mine = previous.then(work);

    // What the next caller waits on: the same work, with its failure absorbed.
    const guarded = mine.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(commonDir, guarded);

    try {
      return await mine;
    } finally {
      // Only forget the repository if nobody queued behind us while we ran, so a long session over
      // many repositories does not accumulate entries forever.
      if (this.tails.get(commonDir) === guarded) {
        this.tails.delete(commonDir);
      }
    }
  }

  /** Whether anything is queued for this repository right now - by common directory, as `run` is. */
  isBusy(commonDir: string): boolean {
    return this.tails.has(commonDir);
  }
}
