/**
 * Streams a repository's history into laid-out pages.
 *
 * The original plan was to page with `--skip=N --max-count=M` over a pinned set of tip SHAs. That
 * turned out to be solving a problem streaming does not have:
 *
 * - `--skip=N` makes git re-walk N commits for every page, which is quadratic across a full scroll.
 * - Pinning tips was only needed because separate `git log` calls can straddle a ref update. One
 *   long-lived process walks a single consistent snapshot, so the inconsistency cannot arise.
 *
 * So: one process, records parsed as they land, and a page emitted every `batchSize` commits. The
 * first page reaches the screen while git is still walking, which is the whole point.
 */

import type { Git } from './exec.ts';
import { until } from './exec.ts';
import type { RepoInfo } from './discovery.ts';
import type { Commit } from './logParser.ts';
import { Interner, LOG_ARGS, parseLog } from './logParser.ts';
import type { CommitOrder } from '../protocol.ts';
import type { GraphDelta } from '../graph/layout.ts';
import { LayoutState, appendCommits, finishLayout } from '../graph/layout.ts';

const RECORD = '\x1e';

export interface Page {
  readonly commits: Commit[];
  readonly delta: GraphDelta;
  /** True on the final page, once every lane has been closed off. */
  readonly done: boolean;
}

export interface HistoryOptions {
  /** Commits per page delivered to the view. */
  readonly batchSize?: number;
  /** Hard ceiling, so a pathological repository cannot exhaust the extension host. */
  readonly maxCommits?: number;
  /** Extra `git log` arguments - this is where search and filter push work down into git. */
  readonly filters?: readonly string[];
  /**
   * Refs to walk. Omit, or pass null, to walk everything via `--all` - cheaper than spelling out
   * hundreds of refs on a command line when none of them are filtered out anyway.
   */
  readonly refs?: readonly string[] | null;
  /**
   * Walk only the first parent of every merge.
   *
   * Two halves of one thing: git is told to leave the merged-in commits out of the walk, and the
   * layout is told not to draw the arcs to them - which would otherwise point at rows that are no
   * longer there. Turning on only the drawing half would make a merge dot with nothing joining it,
   * a graph that lies by leaving something out.
   */
  readonly firstParentOnly?: boolean;
  /**
   * Only the commits nothing else can reach.
   *
   * "Show me this branch" narrows the tips git walks *from*, which for a branch cut off a trunk
   * that has had three hundred others merged into it is barely a narrowing at all: everything
   * merged in is reachable, so it is all in the walk, labels and lanes and all. This is the other
   * question - what does this branch have that no other ref does - and it is the one people mean
   * by "what did I do here".
   *
   * Needs a ref list to be about: with everything ticked there is nothing left to exclude.
   */
  readonly onlyHere?: boolean;
  /** How to order the walk. Omitted is `date`, which is what it always did. */
  readonly order?: CommitOrder;
  /**
   * Stash commits to fold into the walk, keyed by SHA. Only the newest stash is a ref, so the rest
   * have to be named explicitly or they are invisible.
   */
  readonly stashes?: ReadonlyMap<string, string>;
}

/*
 * The three orders, and why git's own default is not among them.
 *
 * A parent must never precede its child or the lane layout waits forever for a SHA that already
 * went past. Plain chronological order can violate that under clock skew - a commit dated before
 * its parent is one `git commit --date` away - and every one of these three cannot: each is
 * "sort by X, but never show a parent before all of its children". That guarantee is the floor,
 * not a preference, which is why this is a choice between three and not four.
 *
 * They cost the same. Measured on the 100k-commit fixture, first row: date 521ms, author-date
 * 551ms, topo 517ms. The ordering is a question of which shape the history reads best in, not one
 * of what it is worth waiting for.
 */
const ORDER_ARGS: Record<CommitOrder, readonly string[]> = {
  date: ['--date-order'],
  'author-date': ['--author-date-order'],
  topo: ['--topo-order'],
};

export class HistoryLoader {
  private readonly git: Git;
  private readonly repo: RepoInfo;
  private readonly state = new LayoutState();

  constructor(git: Git, repo: RepoInfo) {
    this.git = git;
    this.repo = repo;
  }

  /** Rows laid out so far. */
  get rowCount(): number {
    return this.state.rowIndex;
  }

  /**
   * Walk the history, calling `onPage` as pages become available. Resolves once git has finished
   * and the trailing lanes have been closed.
   */
  async load(
    onPage: (page: Page) => void,
    options: HistoryOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const batchSize = options.batchSize ?? 500;
    const maxCommits = options.maxCommits ?? 250_000;
    const layoutOptions = { firstParentOnly: options.firstParentOnly ?? false };

    const refs = options.refs ?? null;
    const stashes = options.stashes ?? new Map<string, string>();
    const walked = await stashesInWalk(this.git, this.repo, refs, stashes, signal);

    /*
     * An empty ref list is not the same as no ref list: it means the user unticked everything.
     *
     * This has to short-circuit rather than pass no revisions to git, because `git log` with no
     * revision argument defaults to HEAD - so "show me nothing" would quietly render the entire
     * history reachable from the current branch, which looks exactly like the filter being broken.
     */
    if (refs !== null && refs.length === 0) {
      onPage({ commits: [], delta: finishLayout(this.state), done: true });
      return;
    }

    const args = [
      'log',
      ...LOG_ARGS,
      ...(refs === null ? ['--all'] : refs),
      ...walked,
      /*
       * `--not` flips the sense of the revisions after it, and `--exclude` applies to the one
       * `--glob` that follows it - so this reads "and not anything reachable from any ref except
       * the ones asked for".
       *
       * `--glob=refs/*` rather than `--all`, which is the same set plus HEAD - and HEAD is on the
       * branch being asked about, so leaving it in the negative side excludes the branch from
       * itself and the answer is always nothing.
       */
      ...(options.onlyHere === true && refs !== null && refs.length > 0
        ? ['--not', ...refs.map((ref) => `--exclude=${ref}`), '--glob=refs/*']
        : []),
      ...(options.firstParentOnly === true ? ['--first-parent'] : []),
      ...ORDER_ARGS[options.order ?? 'date'],
      `--max-count=${maxCommits}`,
      ...(options.filters ?? []),
    ];

    /**
     * A stash records two or three parents - where HEAD was, the index, and any untracked files -
     * and only the first is history. Drawn literally every stash becomes a three-way merge into
     * commits that exist for no reason the user would recognise, so the rest are dropped here,
     * before the layout ever sees them.
     */
    const foldStashParents = (commits: Commit[]): Commit[] =>
      stashes.size === 0
        ? commits
        : commits.map((commit) =>
            stashes.has(commit.sha) && commit.parents.length > 1
              ? { ...commit, parents: commit.parents.slice(0, 1) }
              : commit,
          );

    const interner = new Interner();
    let buffer = '';
    let batch: Commit[] = [];

    const flush = (): void => {
      if (batch.length === 0) {
        return;
      }

      const delta = appendCommits(this.state, batch, layoutOptions);
      onPage({ commits: batch, delta, done: false });
      batch = [];
    };

    await this.git.stream(
      this.repo.root,
      args,
      (text) => {
        buffer += text;

        // The last piece is whatever git has written so far of the *next* record; it only becomes
        // complete when the following separator arrives.
        const parts = buffer.split(RECORD);
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (part.length > 0) {
            batch.push(...foldStashParents(parseLog(part, interner)));
          }
        }

        if (batch.length >= batchSize) {
          flush();
        }
      },
      signal === undefined ? {} : { signal },
    );

    // Whatever git wrote after the final separator is the last record.
    if (buffer.length > 0) {
      batch.push(...foldStashParents(parseLog(buffer, interner)));
    }

    flush();

    onPage({ commits: [], delta: finishLayout(this.state), done: true });
  }
}

/**
 * Which stashes belong in this walk.
 *
 * A stash is a commit, and naming one puts everything it can reach into the walk with it. That is
 * right while the graph is drawing everything and wrong the moment it is not: a stash made on one
 * branch dragged that branch's whole history into a graph narrowed to a different one, so ticking
 * a single branch produced a graph full of commits from branches that had been unticked - with the
 * stashes sitting at the top of it, which is what gave it away.
 *
 * So a stash is drawn when the commit it was made on is somewhere the walk already goes. Its first
 * parent is that commit; the other one or two are the index and the untracked files, which are not
 * anybody's history.
 *
 * `--is-ancestor` is a reachability query rather than a walk, and the sets here are small - one
 * ticked branch and a handful of stashes is the ordinary case. Past a size where the answer is
 * almost always yes, the question is not worth the processes it would take to ask.
 */
async function stashesInWalk(
  git: Git,
  repo: RepoInfo,
  refs: readonly string[] | null,
  stashes: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<string[]> {
  const all = [...stashes.keys()];

  // Nothing is narrowing the walk, so nothing can be out of place in it.
  if (refs === null || all.length === 0) {
    return all;
  }

  if (refs.length * all.length > 64) {
    return all;
  }

  /*
   * One stash at a time was the last thing between the reader and their first row.
   *
   * These are independent questions - whether *this* stash hangs off something being walked has
   * nothing to do with the next one - and they were asked one after another. Measured on a
   * 78,000-commit repository with three stashes: 649ms of nothing but process startup, on the
   * default view, on every reload. Spawning git costs more than answering on Windows.
   *
   * Across stashes rather than across everything: each one still tries its refs in order and stops
   * at the first that contains it, which for the ordinary single-ticked-branch view is one probe.
   * `Git` caps how many processes run at once and queues the rest, so this cannot become a storm.
   *
   * One command for all of them would be better still, and there is no correct one: `rev-list
   * --no-walk` is documented to have no effect once a range is given, and `--not <refs>` is a
   * range - measured, it walked 63,130 commits and answered the wrong question.
   */
  const reachable = await Promise.all(
    all.map(async (sha) => {
      for (const ref of refs) {
        const probe = await git.tryRead(
          repo.root,
          ['merge-base', '--is-ancestor', `${sha}^1`, ref],
          until(signal),
        );

        if (probe.exitCode === 0) {
          return true;
        }
      }

      return false;
    }),
  );

  return all.filter((_sha, i) => reachable[i] === true);
}
