/**
 * Ticket ids as links: `ERP-10147` in a commit message, or in a branch's name, opened where the tracker
 * keeps it.
 *
 * Configured rather than guessed - `weft.ticketLinks` is a list of patterns and the address each opens -
 * and the address is only ever built here, on the host. The view sends back the text that was clicked,
 * never an address, and the text has to match a pattern whole before anything opens: a commit message
 * says whatever whoever committed it wrote, and a link it could point anywhere is a link nobody should
 * have to think twice about clicking.
 */

export interface TicketLink {
  /** A regular expression source matching one whole id - `ERP-[0-9]+`, say. */
  readonly pattern: string;
  /** Where it opens: `$0` is the whole id, `$1` its first group, and so on, each percent-encoded. */
  readonly url: string;
}

const WEB = /^https?:\/\//i;

/** The links the setting holds that can be used: a pattern that compiles, and an http or https address. */
export function readTicketLinks(value: unknown): TicketLink[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): TicketLink[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }

    const { pattern, url } = entry as Record<string, unknown>;

    if (typeof pattern !== 'string' || pattern.length === 0 || typeof url !== 'string' || !WEB.test(url)) {
      return [];
    }

    try {
      new RegExp(pattern);
    } catch {
      return [];
    }

    return [{ pattern, url }];
  });
}

/** Where a clicked id opens, or null when no link's pattern matches the whole of it. */
export function ticketUrl(links: readonly TicketLink[], text: string): string | null {
  for (const link of links) {
    const match = new RegExp(`^(?:${link.pattern})$`).exec(text);

    if (match === null) {
      continue;
    }

    const url = link.url.replace(/\$(\d)/g, (_all, n: string) => encodeURIComponent(match[Number(n)] ?? ''));

    // Checked again once it is filled in, though what went in was encoded: a template is trusted for
    // what it turned out to be, not for what it looked like.
    return WEB.test(url) ? url : null;
  }

  return null;
}

/**
 * Where ids occur in a text, as [start, end) spans in order, for the view to mark. An id is not part of
 * a longer word - `XERP-3` holds no ticket - but an underscore separates, so a branch called
 * `Dev_ACR080VN_ERP-10147` holds one. Where two patterns overlap, the one found first is kept.
 */
export function findTickets(patterns: readonly string[], text: string): [number, number][] {
  const found: [number, number][] = [];

  for (const pattern of patterns) {
    let search: RegExp;

    try {
      search = new RegExp(`(?<![A-Za-z0-9-])(?:${pattern})(?![A-Za-z0-9-])`, 'g');
    } catch {
      continue;
    }

    for (const match of text.matchAll(search)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;

      if (match[0].length > 0 && !found.some(([a, b]) => start < b && end > a)) {
        found.push([start, end]);
      }
    }
  }

  return found.sort((a, b) => a[0] - b[0]);
}
