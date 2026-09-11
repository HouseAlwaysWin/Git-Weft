/**
 * Who last touched each line.
 *
 * `--porcelain` rather than any of the pretty formats, because it is the only one that says which
 * *final* line each entry lands on. Blame output is a sequence of hunks in the order git found
 * them, not in file order, and the human formats leave the reader to count.
 *
 * The format repeats a commit's details only the first time that commit appears; every hunk after
 * that is the sha alone. Parsing it therefore means remembering what each sha said, which is also
 * why this returns one array for the whole file rather than answering a line at a time: the second
 * question would have to re-read the first one's answer anyway.
 *
 * **Unsaved buffers.** git blames what is on disk, and an editor holding unsaved edits has moved
 * every line below the first change. `--contents -` hands git the buffer instead, so the line
 * numbers are the ones on screen and the lines that were just typed come back with a sha of all
 * zeroes rather than somebody else's name.
 */

import type { Git } from './exec.ts';
import type { RepoInfo } from './discovery.ts';

export interface BlameLine {
  readonly sha: string;
  readonly author: string;
  /** Author time, epoch milliseconds. */
  readonly authorTime: number;
  /** The commit's subject line. */
  readonly summary: string;
  /** Not committed yet - git spells that sha as forty zeroes. */
  readonly uncommitted: boolean;
}

/**
 * One entry per line of the file, indexed from zero.
 *
 * Sparse on purpose: `undefined` is a line git said nothing about, which is not the same as a line
 * nobody has touched, and a caller that has to tell them apart can.
 */
export type Blame = readonly (BlameLine | undefined)[];

/** `<sha> <line in the original> <line in the file now> [<lines in this hunk>]` */
const HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

export function parseBlame(out: string): Blame {
  const lines: (BlameLine | undefined)[] = [];
  /** What each sha said the first time it appeared, because it only says it once. */
  const seen = new Map<string, { author: string; authorTime: number; summary: string }>();

  let sha = '';
  let row = 0;
  let author = '';
  let authorTime = 0;
  let summary = '';

  for (const raw of out.split('\n')) {
    const header = HEADER.exec(raw);

    if (header !== null) {
      sha = header[1] as string;
      row = Number(header[2]);

      const known = seen.get(sha);

      author = known?.author ?? '';
      authorTime = known?.authorTime ?? 0;
      summary = known?.summary ?? '';
      continue;
    }

    // The trailing space matters: `author-mail`, `author-time` and `author-tz` are not this one.
    if (raw.startsWith('author ')) {
      author = raw.slice('author '.length);
      continue;
    }

    if (raw.startsWith('author-time ')) {
      authorTime = Number(raw.slice('author-time '.length)) * 1000;
      continue;
    }

    if (raw.startsWith('summary ')) {
      summary = raw.slice('summary '.length);
      continue;
    }

    // The line's own text, which is what closes an entry: everything above it described this line.
    if (raw.startsWith('\t') && sha !== '' && row > 0) {
      seen.set(sha, { author, authorTime, summary });

      lines[row - 1] = {
        sha,
        author,
        authorTime,
        summary,
        uncommitted: /^0+$/.test(sha),
      };
    }
  }

  return lines;
}

/**
 * Blame one file.
 *
 * `contents` is the buffer when it differs from what is on disk. Passing it is what keeps the line
 * numbers honest while somebody is typing; leaving it out is cheaper and right for a saved file.
 *
 * A file git will not blame - untracked, outside the repository, binary - comes back empty rather
 * than throwing. There is nothing to show for it, which is a state and not a failure.
 *
 * `line` asks about one line, which is all the annotation at the end of one needs: git then works
 * out that line's history rather than every line of the file. `signal` stops it, and a stopped blame
 * rejects rather than coming back empty - an answer nobody waited for is not "nothing to show".
 */
export async function blameFile(
  git: Git,
  repo: RepoInfo,
  path: string,
  contents?: string,
  options: { readonly line?: number; readonly signal?: AbortSignal } = {},
): Promise<Blame> {
  const args = [
    'blame',
    '--porcelain',
    ...(options.line === undefined ? [] : ['-L', `${options.line + 1},${options.line + 1}`]),
    ...(contents === undefined ? [] : ['--contents', '-']),
    '--',
    path,
  ];

  const out = await git
    .runRead(repo.root, args, {
      ...(contents === undefined ? {} : { stdin: contents }),
      // Spelled out rather than taken from exec.ts's `until`: the webview imports this module for
      // describeAge, and a value import of exec.ts would carry a child process into a browser bundle.
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    .catch((err: unknown) => {
      if (options.signal?.aborted === true) {
        throw err;
      }

      return '';
    });

  return parseBlame(out);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * How long ago, in the words a person would use.
 *
 * Deliberately coarse. "6 months ago" is the answer to why a line looks the way it does; the exact
 * date is a hover away and is not what anybody reads a line-end annotation for.
 */
export function describeAge(then: number, now: number = Date.now()): string {
  const gap = Math.max(0, now - then);

  if (gap < MINUTE) {
    return 'just now';
  }

  const [size, unit] =
    gap < HOUR
      ? [Math.floor(gap / MINUTE), 'minute']
      : gap < DAY
        ? [Math.floor(gap / HOUR), 'hour']
        : gap < MONTH
          ? [Math.floor(gap / DAY), 'day']
          : gap < YEAR
            ? [Math.floor(gap / MONTH), 'month']
            : [Math.floor(gap / YEAR), 'year'];

  return `${size} ${unit}${size === 1 ? '' : 's'} ago`;
}
