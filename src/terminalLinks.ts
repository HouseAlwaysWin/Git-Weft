/**
 * Commit ids in a terminal's output, and where they sit in the line.
 *
 * git prints them everywhere - a commit, a checkout, a rebase, a hook - and the question they raise is
 * always the same: what is 3f2a1b9. The answer is the graph, and reading a line of terminal output is
 * the whole of what stands between the two.
 *
 * Pure, and deliberately shy: a line of text in, the ids it holds out. It is asked for every line the
 * terminal draws, so it does nothing but read - whether an id is a commit in that repository is asked of
 * git once, when somebody clicks it.
 */

/** Where an id sits in a line: what the terminal needs to underline exactly it. */
export interface ShaMatch {
  readonly startIndex: number;
  readonly length: number;
  readonly sha: string;
}

/** Brackets and quotes a word can be wrapped in, which are not part of the id. */
const OPENS = /^[('"[]*/;
const CLOSES = /[)'"\],.:;]+$/;

/**
 * The commit ids a line of terminal output holds.
 *
 * A whole word, seven to forty hex characters, with a letter somewhere in it. Each of those rules is
 * there for something the terminal actually prints:
 *
 * - whole words, because `deadbeef.txt` is a file and `3f2a1b9` in the middle of a word is not an id;
 * - a letter, because a seven-digit number is a number - an id of nothing but digits is rare enough to
 *   be worth losing, and a build number linked to the graph is wrong every time it appears;
 * - nothing from an address or a path, because a hash inside a URL is a link VS Code makes itself.
 *
 * `a1b2c3d..e4f5a6b` is two ids, which is how git writes a range.
 */
export function shasIn(line: string): ShaMatch[] {
  const found: ShaMatch[] = [];

  for (const word of line.matchAll(/\S+/g)) {
    const text = word[0];
    const at = word.index ?? 0;

    if (text.includes('://') || text.includes('@') || text.includes('/') || text.includes('\\')) {
      continue;
    }

    let from = 0;

    for (const piece of text.split('..')) {
      const lead = OPENS.exec(piece)?.[0].length ?? 0;
      const sha = piece.slice(lead).replace(CLOSES, '');

      if (/^[0-9a-f]{7,40}$/.test(sha) && /[a-f]/.test(sha)) {
        found.push({ startIndex: at + from + lead, length: sha.length, sha });
      }

      // The two dots go back on, so the second id of a range is where the line says it is.
      from += piece.length + 2;
    }
  }

  return found;
}
