/**
 * The extension <-> webview contract.
 *
 * Two rules keep this cheap:
 *
 * - **Pages, never the whole history.** `postMessage` structured-clones its payload; handing it
 *   100k commits in one call freezes the extension host for seconds. Rows arrive in batches as git
 *   produces them.
 * - **Deltas, never restatements.** A page carries only the rows and lane points that are new. The
 *   webview appends; it never re-lays-out or re-renders what it already has.
 */

import type { GraphDelta } from './graph/layout.ts';
import type { GitRef } from './git/logParser.ts';
import type { CommitDetails } from './git/details.ts';
import type { Search } from './git/search.ts';
import type { DateRange } from './git/dates.ts';
import type { BranchFolders } from './git/refFolders.ts';
import type { MenuItem, Target } from './actions/registry.ts';

/**
 * A commit's identity and message.
 *
 * Without its files: those go to the Commit Files section in Source Control, not through here. It
 * saves a structured clone of every changed file on every arrow-key press through the history, and
 * the view has nothing to do with them.
 */
export type CommitInfo = Omit<CommitDetails, 'files'>;

/** One commit as the webview needs it - the extension's richer `Commit` is not sent wholesale. */
export interface Row {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  readonly refs: readonly GitRef[];
  readonly isHead: boolean;
  /** `stash@{0}` when this row is a stash rather than a commit. */
  readonly stash?: string;
  /**
   * True for the one row that is not a commit at all: the working tree.
   *
   * The view builds it rather than the host sending it, because it is not part of the history and
   * must not be part of the layout - the lanes are indexed by commit, and a row that comes and goes
   * as files are saved would renumber every one of them.
   */
  readonly uncommitted?: boolean;
}

/** Draw every ref, draw none of them, or draw the branch HEAD is on. */
export type RefsPreset = 'all' | 'none' | 'current';

/**
 * One ref, as the branch menu in the header needs it.
 *
 * `visible` is the same switch as the tick in Branches & Tags, not a second one: the header is
 * another way into one piece of state, and two controls disagreeing about which branches are drawn
 * would be worse than having only the one.
 */
export interface RefEntry {
  readonly label: string;
  readonly refName: string;
  readonly kind: 'local' | 'remote' | 'tag';
  readonly visible: boolean;
  /** When the ref last moved, epoch milliseconds, or 0 for a ref that will not say. */
  readonly updated: number;
}

/** A named set of ticks, as the header's menu offers it: its name, and what it draws in a few words. */
export interface RefsPresetEntry {
  readonly name: string;
  readonly describes: string;
}

/**
 * How git is asked to order the walk.
 *
 * Three, not four: git's own chronological order can put a parent before its child under clock
 * skew, which the lane layout cannot survive, so it is not on offer. `date` is what Weft has always
 * done and stays the default.
 */
export type CommitOrder = 'date' | 'author-date' | 'topo';

export type HostMessage =
  | {
      readonly type: 'init';
      readonly repoName: string;
      readonly repoRoot: string;
      readonly rowHeight: number;
      /** Whether author names are tinted per author. */
      readonly authorColors: boolean;
      /** Set when the repository is anything other than an ordinary clone, for the header. */
      readonly kind: string | null;
    }
  | {
      readonly type: 'page';
      readonly rows: readonly Row[];
      readonly delta: GraphDelta;
    }
  | {
      readonly type: 'done';
      readonly total: number;
      readonly elapsedMs: number;
      /** The walk stopped at `weft.maxCommits` rather than at the end of the history. */
      readonly truncated: boolean;
    }
  /**
   * What is in the working tree, sent on every reload. Zero files means there is nothing to show a
   * row for, which is the ordinary state of a repository nobody is in the middle of editing.
   */
  | {
      readonly type: 'working';
      readonly total: number;
      readonly staged: number;
      readonly unstaged: number;
      readonly untracked: number;
      readonly conflicted: number;
      /** The branch the changes would land on, or null when HEAD is detached. */
      readonly branch: string | null;
      /** Where that branch stands against the one it tracks, or null when it tracks nothing. */
      readonly upstream: {
        readonly ref: string;
        readonly ahead: number;
        readonly behind: number;
        readonly gone: boolean;
      } | null;
      /**
       * When a remote was last heard from, as epoch milliseconds.
       *
       * The counts above are a statement about that moment rather than about now, and without it
       * beside them they read as current - which is the whole way a stale graph misleads.
       */
      readonly fetchedAt: number | null;
    }
  /** Every ref there is, so the header can offer them without asking for them. */
  | {
      readonly type: 'refs';
      /** The branch HEAD is on, or null when it is detached. */
      readonly branch: string | null;
      readonly refs: readonly RefEntry[];
      /** The named sets of ticks, for the menu to offer as one click each. */
      readonly presets: readonly RefsPresetEntry[];
      /** `weft.branchFolders`, so the menu folds its lists as the sidebar does. */
      readonly folders: BranchFolders;
    }
  /** A fresh load is starting. `filtered` is whether anything is narrowing it, from any source. */
  | { readonly type: 'reset'; readonly filtered: boolean }
  /** Every filter has been dropped at once; put the boxes back without asking for another walk. */
  | { readonly type: 'filtersCleared' }
  | { readonly type: 'details'; readonly details: CommitInfo }
  /**
   * The result of comparing two commits. The files went to Source Control; what comes back here is
   * only what the pane needs to describe the range.
   */
  | {
      readonly type: 'comparison';
      readonly from: string;
      readonly to: string;
      readonly files: number;
      readonly onlyFrom: number;
      readonly onlyTo: number;
    }
  /** The repository changed under us and the graph has been reloaded from scratch. */
  | { readonly type: 'reloading'; readonly reason: string }
  | {
      readonly type: 'menu';
      readonly target: Target;
      readonly items: readonly MenuItem[];
      /** Echoed back from the request so the menu opens where the click was. */
      readonly x: number;
      readonly y: number;
    }
  /**
   * What git is halfway through, if anything. Sent on every reload: a graph that shows history
   * while hiding an unfinished rebase is how people end up several commands deep in something they
   * did not know they were in.
   */
  | {
      readonly type: 'operation';
      /** 'none' when nothing is in progress. */
      readonly operation: string;
      readonly description: string;
      readonly conflicted: readonly string[];
      readonly controls: readonly MenuItem[];
    }
  /**
   * Put the cursor on one commit, wherever the reader came from.
   *
   * By sha rather than by row, because a row number belongs to one walk: the message is sent once
   * when it is asked for and again when the page carrying that commit lands, and forty thousand
   * rows can arrive in between.
   */
  | { readonly type: 'reveal'; readonly sha: string }
  /** Ask the view to search for one file's history. It owns the boxes, so it sets them itself. */
  | { readonly type: 'showHistory'; readonly path: string }
  | { readonly type: 'error'; readonly message: string };

export type WebviewMessage =
  /*
   * The panel is built with `retainContextWhenHidden: false`, so hiding the tab destroys the view
   * and showing it again builds a fresh one - while the host still holds the filters the old one
   * set. The restored filters travel with the handshake so the two cannot disagree: whatever the
   * boxes say after a reload is what the graph was walked with.
   */
  | {
      readonly type: 'ready';
      readonly search: Search | null;
      readonly dates: DateRange | null;
      readonly firstParent: boolean;
      /** Whether the walk is narrowed to what no other ref can reach. */
      readonly onlyHere: boolean;
      readonly order: CommitOrder;
    }
  | { readonly type: 'refresh' }
  /** Drop the search, the date range, and the sidebar's ref and author filters, all at once. */
  | { readonly type: 'clearFilters' }
  /** Walk only what the ticked refs have and every other ref does not. */
  | { readonly type: 'onlyHere'; readonly on: boolean }
  | { readonly type: 'search'; readonly search: Search | null }
  /** Narrow the walk to a stretch of time. Separate from the search: the two combine. */
  | { readonly type: 'dates'; readonly range: DateRange | null }
  /** Walk only the first parent of every merge: the mainline, without what was merged into it. */
  | { readonly type: 'firstParent'; readonly on: boolean }
  | { readonly type: 'order'; readonly order: CommitOrder }
  | { readonly type: 'selectCommit'; readonly sha: string }
  /** The working-tree row was picked. It has no commit to load, only files to list. */
  | { readonly type: 'selectUncommitted' }
  /** Two commits were picked. What they differ by is a range, not either one of them. */
  | { readonly type: 'compare'; readonly from: string; readonly to: string }
  | { readonly type: 'copy'; readonly text: string }
  /** Right-click: the host decides what is on the menu, because availability depends on repo state. */
  | { readonly type: 'requestMenu'; readonly target: Target; readonly x: number; readonly y: number }
  | {
      readonly type: 'runAction';
      readonly id: string;
      readonly target: Target;
    }
  /**
   * Draw these refs, or stop drawing them - the same switch the sidebar's ticks set.
   *
   * A list rather than one name, because a group's tick moves all of them at once and doing that as
   * fifty messages would be fifty reloads of the graph.
   */
  | { readonly type: 'setRefsVisible'; readonly refNames: readonly string[]; readonly visible: boolean }
  /**
   * The three answers worth one click, the same three the sidebar's title bar offers.
   *
   * A preset rather than a list of ref names: "everything" on a repository with fourteen hundred
   * refs would be fourteen hundred names across the wire to say something the other side can work
   * out for itself, and "the branch you are on" is not something the view knows at all - the ticks
   * follow HEAD, and HEAD is the host's to read.
   */
  | { readonly type: 'refsPreset'; readonly preset: RefsPreset }
  /** Draw a named set of ticks, from its chip in the header's menu. */
  | { readonly type: 'applyRefsPreset'; readonly name: string }
  /**
   * Save the ticks as a preset, or manage the ones there are. Asked of the host, which does the
   * asking: a name is typed into VS Code's own box, not into one drawn here.
   */
  | { readonly type: 'saveRefsPreset' }
  | { readonly type: 'manageRefsPresets' }
  /** Hand a conflicted file to VS Code, whose merge editor is better at this than anything here. */
  | { readonly type: 'openConflict'; readonly path: string };
