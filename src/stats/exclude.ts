/**
 * Which commits the statistics leave out by their message: `weft.statistics.excludeMessages`, read into
 * patterns.
 *
 * The graph draws every commit it walks either way. A commit a rule matches is left out of the charts only -
 * and counted apart, the way merges are, so the tab can say how many and put them back.
 */

/** The rules as written, sorted into the ones that can be used and the ones that cannot. */
export interface Exclusions {
  /** One pattern for each rule that could be used, to match a commit's subject against. */
  readonly patterns: readonly RegExp[];
  /** Those rules as they were written, in the same order. */
  readonly rules: readonly string[];
  /** The rules that could not be used, as written. They leave nothing out. */
  readonly unreadable: readonly string[];
}

/**
 * Read the setting's rules.
 *
 * A rule that is not a regular expression is set aside rather than thrown on: one mistyped bracket in a
 * settings file must not take the statistics down with it, and the tab names the rule. So is an empty one,
 * which as a pattern matches every subject there is - a tab with nothing left on it, from a rule half typed.
 */
export function readExclusions(setting: unknown): Exclusions {
  const patterns: RegExp[] = [];
  const rules: string[] = [];
  const unreadable: string[] = [];

  for (const rule of Array.isArray(setting) ? (setting as unknown[]) : []) {
    if (typeof rule !== 'string' || rule.trim() === '') {
      unreadable.push(typeof rule === 'string' ? rule : String(rule));
      continue;
    }

    try {
      patterns.push(new RegExp(rule));
      rules.push(rule);
    } catch {
      unreadable.push(rule);
    }
  }

  return { patterns, rules, unreadable };
}
