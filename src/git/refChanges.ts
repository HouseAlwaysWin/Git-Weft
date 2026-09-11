/**
 * Whether a change to the refs changes what the graph has drawn.
 *
 * That is the question a walk answers, and on a large repository a walk costs seconds. Most ref
 * changes there are to branches nobody is drawing - a fetch moves dozens of a thousand remote
 * branches - and every one of them used to re-walk the history of the branch on screen, to draw it
 * exactly as it was.
 *
 * "Not drawn" is not "not on screen", though. The walk decorates every row with every ref that points
 * at it, ticked or not, so a hidden branch pointing into the drawn history is a badge on a drawn row,
 * and it moving onto or off one changes the picture as surely as a drawn branch moving does.
 *
 * So a change is on screen when HEAD moved; when a drawn ref moved; when the stash did, which is
 * drawn by what it hangs off rather than by a tick; when a tag did, because an annotated tag's object
 * is not the commit it badges and so cannot be looked up among the rows; or when any ref that moved
 * pointed at a drawn row before, or points at one now.
 */

/** What the graph drew, as far as the question needs it. */
export interface Drawing {
  /** The refs walked - by the last walk and by the next, both - or null when that is all of them. */
  readonly drawn: ReadonlySet<string> | null;
  /** Every commit the walk has drawn. */
  readonly walked: ReadonlySet<string>;
  /** Whether the walk finished. Until it has, what it will draw is not known, so everything counts. */
  readonly complete: boolean;
  /** Only what the drawn refs have and no other ref does: then every ref is part of the answer. */
  readonly exclusive: boolean;
}

/**
 * `before` and `after` are a fingerprint's `refs`: HEAD's commit on the first line, then
 * `%(HEAD)%(objectname)%(refname)` for each ref - a `*` or a space, the object, the name.
 */
export function changesDrawing(before: string, after: string, drawing: Drawing): boolean {
  if (!drawing.complete || drawing.exclusive || drawing.drawn === null) {
    return true;
  }

  const drawn = drawing.drawn;
  const walked = drawing.walked;
  const [headBefore = '', ...restBefore] = before.split('\n');
  const [headAfter = '', ...restAfter] = after.split('\n');

  if (headBefore.trim() !== headAfter.trim()) {
    return true;
  }

  const was = parse(restBefore);
  const now = parse(restAfter);

  for (const name of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(name);
    const b = now.get(name);

    if (a?.object === b?.object && a?.head === b?.head) {
      continue;
    }

    if (drawn.has(name) || name === 'refs/stash' || name.startsWith('refs/tags/') || a?.head === true || b?.head === true) {
      return true;
    }

    if ((a !== undefined && walked.has(a.object)) || (b !== undefined && walked.has(b.object))) {
      return true;
    }
  }

  return false;
}

interface Entry {
  readonly object: string;
  readonly head: boolean;
}

function parse(lines: readonly string[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();

  for (const line of lines) {
    // The object is hex and every name starts "refs/", so the first "refs/" after the marker splits them.
    const at = line.indexOf('refs/', 1);

    if (at > 0) {
      entries.set(line.slice(at).trimEnd(), { object: line.slice(1, at), head: line.startsWith('*') });
    }
  }

  return entries;
}
