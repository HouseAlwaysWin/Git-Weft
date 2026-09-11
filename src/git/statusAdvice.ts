/**
 * When `git status` is slow, and what to offer about it.
 *
 * Weft re-reads the working tree when files change, and on a large repository that read is `git
 * status` looking at every file - the better part of a second on a 38,000-file worktree with nothing
 * configured. git has two switches for exactly this, both off unless someone turns them on: the
 * untracked cache, which remembers which directories have nothing new in them, and a filesystem
 * monitor, which asks the operating system what changed instead of looking. Both are set per
 * repository, and neither is something anyone finds by accident.
 */

/** Slow reads of one repository before asking about it. */
export const SLOW_READS_BEFORE_ASKING = 3;

/** What a repository has set already, as `git config --get` printed it, or null when unset. */
export interface StatusConfig {
  readonly untrackedCache: string | null;
  readonly fsmonitor: string | null;
}

export interface StatusOffer {
  readonly untrackedCache: boolean;
  readonly fsmonitor: boolean;
}

/**
 * Which switches to offer: only ones nobody has set. Set to anything - false included - is a choice
 * somebody made, and `core.fsmonitor` may name a hook of their own, such as Watchman's. A monitor only
 * where git says one can run.
 */
export function statusOffer(config: StatusConfig, fsmonitorRuns: boolean): StatusOffer {
  return {
    untrackedCache: config.untrackedCache === null,
    fsmonitor: fsmonitorRuns && config.fsmonitor === null,
  };
}

/**
 * git's own answer to "could a filesystem monitor run here", from `git fsmonitor--daemon status`.
 *
 * It exits 0 when a monitor is watching and 1 when none is, and dies with 128 on a platform without
 * the built-in daemon, or for a repository it will not watch, such as one on a network share. Asking
 * git, rather than guessing from the platform and the path, is what keeps the offer off a share that
 * git would refuse to watch anyway.
 */
export function fsmonitorCanRun(exitCode: number | null): boolean {
  return exitCode === 0 || exitCode === 1;
}

/**
 * Slow reads per repository, and when to ask: once, at the third.
 *
 * Counted against a threshold, so a new threshold starts the count again - a read that was slow under
 * the old one says nothing under the new. Kept for the session only: what anyone answered is kept
 * elsewhere, and a slow read last week is not a reason to ask today.
 */
export class SlowReads {
  private readonly counts = new Map<string, number>();
  private threshold: number | null = null;

  /** Whether this read is the one to ask after. */
  record(root: string, durationMs: number, thresholdMs: number): boolean {
    if (thresholdMs !== this.threshold) {
      this.counts.clear();
      this.threshold = thresholdMs;
    }

    if (thresholdMs <= 0 || durationMs < thresholdMs) {
      return false;
    }

    const count = (this.counts.get(root) ?? 0) + 1;
    this.counts.set(root, count);
    return count === SLOW_READS_BEFORE_ASKING;
  }
}
