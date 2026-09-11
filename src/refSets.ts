/**
 * Which refs the graph draws, kept as the choice somebody made rather than as its result.
 *
 * The sidebar used to keep the refs it had hidden and nothing else. That is the right record of
 * "everything but these": a branch fetched tomorrow is not among them, so it is drawn, which is what
 * everything-but means. It is the wrong record of "only these three", which was kept the same way -
 * as every other ref that existed at the moment of choosing - so a branch fetched tomorrow was not
 * among the hidden either, and joined a hand-picked set that nobody had picked it for. On a
 * repository with a thousand remote branches, a few fetches turn a set of three into thirty.
 *
 * So the choice is kept as what it was: `only` draws the refs it names and nothing that arrives
 * later, and `except` draws everything but the refs it names, arrivals included.
 */

export interface RefSet {
  readonly mode: 'only' | 'except';
  /** Full ref names, each once, sorted. */
  readonly refs: readonly string[];
}

/** Draw these and nothing else, now or later. */
export function only(refs: Iterable<string>): RefSet {
  return { mode: 'only', refs: tidy(refs) };
}

/** Draw everything but these, including whatever arrives later. */
export function except(refs: Iterable<string>): RefSet {
  return { mode: 'except', refs: tidy(refs) };
}

/** The refs, among the ones that exist now, that the set keeps out of the graph. */
export function hiddenBy(set: RefSet, all: readonly string[]): Set<string> {
  const named = new Set(set.refs);
  return new Set(all.filter((ref) => (set.mode === 'only' ? !named.has(ref) : named.has(ref))));
}

/** The same choice, with these refs switched on or off. */
export function withVisible(set: RefSet, refNames: readonly string[], visible: boolean): RefSet {
  const named = new Set(set.refs);
  // In `only` the refs named are the drawn ones, and in `except` the hidden ones.
  const naming = set.mode === 'only' ? visible : !visible;

  for (const ref of refNames) {
    if (naming) {
      named.add(ref);
    } else {
      named.delete(ref);
    }
  }

  return { mode: set.mode, refs: tidy(named) };
}

/** Only the refs that still exist: a deleted branch has nothing left to be ticked or not. */
export function pruned(set: RefSet, all: readonly string[]): RefSet {
  const exists = new Set(all);
  return { mode: set.mode, refs: set.refs.filter((ref) => exists.has(ref)) };
}

/** What a repository's ticks are kept as between sessions. */
export interface StoredTicks {
  readonly v: 1;
  /** The ref HEAD was on, so that coming back is not read as a checkout - which resets the ticks. */
  readonly head: string | null;
  /** Still the default, the branch HEAD is on, rather than a set anybody chose. */
  readonly following: boolean;
  readonly set: RefSet;
}

/** A set read back from storage, or null for anything that is not one. */
export function readRefSet(value: unknown): RefSet | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const mode = record.mode === 'only' ? 'only' : record.mode === 'except' ? 'except' : null;
  const raw: unknown = record.refs;

  if (mode === null || !Array.isArray(raw)) {
    return null;
  }

  const refs = raw.filter((ref): ref is string => typeof ref === 'string');
  return refs.length === raw.length ? { mode, refs: tidy(refs) } : null;
}

/** Ticks read back from storage, or null for anything that is not a version this understands. */
export function readStoredTicks(value: unknown): StoredTicks | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const head = record.head === null ? null : typeof record.head === 'string' ? record.head : undefined;
  const following = typeof record.following === 'boolean' ? record.following : undefined;
  const set = readRefSet(record.set);

  if (record.v !== 1 || head === undefined || following === undefined || set === null) {
    return null;
  }

  return { v: 1, head, following, set };
}

function tidy(refs: Iterable<string>): string[] {
  return [...new Set(refs)].sort();
}

/** Named sets read back from storage, dropping any entry that is not one. */
export function readPresets(value: unknown): Map<string, RefSet> {
  const presets = new Map<string, RefSet>();

  if (typeof value !== 'object' || value === null) {
    return presets;
  }

  for (const [name, stored] of Object.entries(value as Record<string, unknown>)) {
    const set = readRefSet(stored);

    if (name.trim().length > 0 && set !== null) {
      presets.set(name, set);
    }
  }

  return presets;
}

/** A set in a few words, for a list of them: how much it draws, or how much it leaves out. */
export function describeSet(set: RefSet): string {
  const n = set.refs.length;

  if (set.mode === 'only') {
    return n === 0 ? 'nothing' : `${n} ${n === 1 ? 'ref' : 'refs'}`;
  }

  return n === 0 ? 'everything' : `everything but ${n}`;
}
