/**
 * The graph webview panel: one per repository.
 *
 * A `WebviewPanel` rather than a `CustomEditorProvider`, because a custom editor binds a webview to
 * a file on disk and "the history of a repository" is not a file.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { HistoryLoader } from './git/history.ts';
import type { CommitDetails } from './git/details.ts';
import type { FileStatus } from './git/repoState.ts';
import type { Comparison } from './git/details.ts';
import { compareCommits, loadCommitDetails } from './git/details.ts';
import { RepoWatcher, headBranchOf, repoFingerprint } from './git/watcher.ts';
import type { Fingerprint } from './git/watcher.ts';
import { changesDrawing } from './git/refChanges.ts';
import type { Search } from './git/search.ts';
import type { AuthorPick } from './git/search.ts';
import { filterArgs } from './git/search.ts';
import type { DateRange } from './git/dates.ts';
import { dateArgs } from './git/dates.ts';
import type {
  CommitOrder,
  CompareEnd,
  HostMessage,
  RefEntry,
  RefsPreset,
  RefsPresetEntry,
  Row,
  WebviewMessage,
} from './protocol.ts';
import { BODY_MARKUP } from './webview/markup.ts';

/**
 * Everything outside the panel that narrows what the graph walks. One object rather than a growing
 * list of callbacks, and read fresh on every reload so the panel never holds a stale copy.
 */
export interface FilterSource {
  /**
   * Which refs to walk, for one repository.
   *
   * The root is not decoration. Every open graph reloads when a tick moves in the sidebar, and the
   * sidebar is showing one repository - so without it, unticking a branch in one graph reloads the
   * other with a list of ref names that do not exist in it, and empties it.
   */
  refs(root: string): string[] | null;
  /**
   * Whether those refs are narrowing anything a fresh graph would not.
   *
   * Separate from `refs` returning a list, because the default is itself a list: a graph opens on
   * the branch you are on. Treating that as a filter would light "clear filters" on every graph
   * that has never been filtered.
   */
  refsNarrowed(root: string): boolean;
  /**
   * The ticked authors, as people rather than as arguments.
   *
   * `filterArgs` writes the `--author` line, because the search box may be filtering by author too
   * and git would union the two rather than intersect them.
   */
  authorPicks(root: string): AuthorPick[];
  /** Every ref with whether it is drawn, for the header's branch menu. */
  listRefs(): RefEntry[];
  /** The named sets of ticks, for the same menu. */
  refPresets(): RefsPresetEntry[];
  /** Draw one of them. */
  applyRefPreset(name: string): void;
  /** Switch them on or off. The same call the sidebar's own ticks make, so the two cannot drift. */
  setRefsVisible(refNames: readonly string[], visible: boolean): void;
  /** Everything, nothing, or the branch HEAD is on - the sidebar's three buttons, from the graph. */
  setRefsPreset(preset: RefsPreset): void;
  /**
   * Drop everything the sidebar is narrowing by, without announcing it. The caller reloads once,
   * rather than each view asking for a reload of its own on the way past.
   */
  clear(): void;
  /**
   * Refs have moved - re-read them.
   *
   * Not a filter, and here anyway: this is the channel the sidebar and the panel already talk
   * over, and a second one for a single callback would be worse than the stretch in the name.
   * Without it Branches & Tags reads the refs once, when the graph opens, and never again - so
   * deleting a branch removed it from git and left it on screen, which from the outside is
   * indistinguishable from the delete having done nothing.
   */
  refsMoved(): Promise<void>;
  /** A graph took focus; point the sidebar at its repository. */
  activated(repo: RepoInfo): void;
}
import { RepoLock } from './git/lock.ts';
import type { WorkingTree } from './git/repoState.ts';
import { describeOperation, readRepoState, readWorkingTree } from './git/repoState.ts';
import { readTicketLinks, ticketUrl } from './git/ticketLinks.ts';
import { parsePicked, pickedArgs, refsFor, remotesIn, tookTestBranch } from './git/testMerges.ts';
import { openUrl } from './openUrl.ts';
import { coalesce } from './coalesce.ts';
import { watchWorkingTree } from './git/vscodeGit.ts';
import type { BranchFolders } from './git/refFolders.ts';
import { listStashes } from './git/stash.ts';
import { Remedy, mapGitError } from './git/errors.ts';
import { explainStaleLock } from './git/staleLock.ts';
import { describeAge } from './git/blame.ts';
import type { ActionContext, ActionUi, Target } from './actions/registry.ts';
import { buildMenu, confirmIfNeeded, findAction } from './actions/registry.ts';
import { readExclusions } from './stats/exclude.ts';
import { describeScope } from './stats/scope.ts';
import type { Walk } from './stats/tally.ts';
import { CommitTally } from './stats/tally.ts';

/** Set by the extension so panels can write to - and reveal - the same output channel. */
type Logger = { info(message: string): void; warn(message: string): void; show(): void };

let output: Logger | undefined;

/**
 * Where a selected commit's file list goes: the Commit Files section in Source Control.
 *
 * A module-level sink rather than something threaded through every panel, for the same reason the
 * logger is one - there is exactly one of it, and which panel you clicked in is not information the
 * section wants. It shows the last commit anyone selected, and empties when the last graph closes.
 */
type CommitFilesSink = {
  show(repo: string, details: CommitDetails): void;
  working(repo: string, files: readonly FileStatus[]): void;
  compared(repo: string, comparison: Comparison, labels: { readonly from: string; readonly to: string }): void;
  clear(): void;
};

let commitFiles: CommitFilesSink | undefined;

export function setCommitFiles(sink: CommitFilesSink): void {
  commitFiles = sink;
}

export function setPanelLogger(logger: Logger): void {
  output = logger;
}

/**
 * Who hears that a graph's walk started, finished or failed, or that the graph closed: the statistics tabs,
 * through the extension. A callback rather than an import, so the graph knows nothing of what is drawn from
 * its walks.
 */
let walkListener: ((root: string) => void) | undefined;

export function setWalkListener(listener: (root: string) => void): void {
  walkListener = listener;
}

/** What each remedy reads as on a button. Short enough to sit next to the message. */
const REMEDY_LABELS: Record<Remedy, string> = {
  [Remedy.StashAndRetry]: 'Stash and Retry',
  [Remedy.Retry]: 'Try Again',
  [Remedy.ResolveConflicts]: 'Show Conflicts',
  [Remedy.AbortOperation]: 'Abort',
  [Remedy.Fetch]: 'Fetch',
  [Remedy.ShowLog]: 'Show Git Log',
};

export const VIEW_TYPE = 'weft.graph';

/**
 * How many patch-id comparisons one walk will wait for - see `pickedFrom`.
 *
 * Each is a read of two histories, measured at 0.9 seconds on a repository of 64,204 commits, and the
 * number of them is the drawn refs times the refs each named branch has. Six is two test sites against
 * their local and remote copies with a graph drawing one branch, or one test site with three branches
 * ticked; past that the switch would cost more than the walk it narrows.
 */
const PICK_READS = 6;

function describe(repo: RepoInfo): string | null {
  if (repo.isBare) {
    return 'bare';
  }

  if (repo.isLinkedWorktree) {
    return 'linked worktree';
  }

  if (repo.superproject !== null) {
    return 'submodule';
  }

  return null;
}

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return out;
}

export class WeftPanel {
  private static readonly open = new Map<string, WeftPanel>();
  private static current: WeftPanel | null = null;
  /** Shared across panels: two graphs on the same repository must not write at once. */
  private static readonly lock = new RepoLock();

  /**
   * Run `work` holding a repository's lock, for a write that does not come from a graph - git's
   * own settings, say - and still has to queue behind a checkout rather than run alongside it.
   */
  static exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
    return WeftPanel.lock.run(root, work);
  }

  /** The graph the user is looking at, for commands that act on "this graph". */
  static active(): WeftPanel | null {
    return WeftPanel.current;
  }

  /**
   * Reload every open graph.
   *
   * For anything driven from outside the webview, which is to say from the sidebar. `active()` is
   * the *focused* graph, and clicking a checkbox in Source Control is precisely the act of taking
   * focus away from it - so a filter that reloaded `active()` reloaded nothing at all, every time.
   */
  static refreshAll(): void {
    for (const panel of WeftPanel.open.values()) {
      panel.refresh();
    }
  }

  /**
   * Reload the graph of one repository, for a filter that belongs to that repository.
   *
   * `refreshAll` was doing this job. Besides the cost - a walk of a whole history nobody asked
   * about - the sidebar answers `visibleRefs` for the repository it is showing and null for any
   * other, and null means every ref: so a tick in one repository quietly widened a graph somewhere
   * else from the branch it was drawing to all of them, and paid a `git log --all` to do it.
   *
   * A filter with no repository behind it reloads nothing: there is nothing it could be about.
   */
  static refreshRoot(root: string | null): void {
    if (root === null) {
      return;
    }

    for (const panel of WeftPanel.open.values()) {
      if (panel.root === root) {
        panel.refresh();
      }
    }
  }

  /**
   * Send the ticket patterns again, without re-walking anything.
   *
   * For `weft.ticketLinks`: a correction typed while graphs are open is a change to which ids are
   * marked, and nothing else. The alternative was a reload of every open graph - a walk of a whole
   * history because somebody fixed a bracket.
   */
  static refreshTicketPatterns(): void {
    const config = vscode.workspace.getConfiguration('weft');
    const patterns = readTicketLinks(config.get<unknown[]>('ticketLinks', [])).links.map((link) => link.pattern);

    for (const panel of WeftPanel.open.values()) {
      panel.post({ type: 'ticketPatterns', patterns });
    }
  }

  /**
   * Send the ref list again, without re-walking anything.
   *
   * For the sidebar's sort buttons: the order of a list is not a question about which commits are
   * on screen, and `refreshAll` would answer it with a walk of the whole history.
   */
  static refreshRefs(): void {
    for (const panel of WeftPanel.open.values()) {
      panel.postRefs(panel.headBranch);
    }
  }

  /**
   * Compare two branches or tags from outside the graph - Branches & Tags, the palette - in the graph
   * of the repository they belong to, as if they had been picked there. False when no graph is open
   * for it, since the comparison would have nowhere to be shown.
   */
  static async compareIn(root: string, from: CompareEnd, to: CompareEnd): Promise<boolean> {
    const panel = WeftPanel.open.get(root);

    if (panel === undefined) {
      return false;
    }

    // In front, without taking the focus from wherever it was asked.
    panel.panel.reveal(undefined, true);
    await panel.showComparison(from, to);
    return true;
  }

  /**
   * Whether the graph is drawing what `rev` names. A branch or tag is drawn when the last walk named
   * it, or named everything; a commit was picked off the graph, so it is there.
   */
  private drawing(rev: string): boolean {
    return !rev.startsWith('refs/') || this.drawnRefs === null || this.drawnRefs.includes(rev);
  }

  /**
   * Whether a write is in flight against this repository.
   *
   * Exposed because the rule it enforces is not the panel's: anything that runs git against a
   * repository while something else is writing to it is a process holding files open at exactly
   * the wrong moment. On Windows that is not a slowdown but a failure - git renames a lock over
   * the file it is replacing, and Windows refuses that while any other process has the old one
   * open.
   */
  static isBusy(root: string): boolean {
    return WeftPanel.lock.isBusy(root);
  }

  /** Any open graph, for a sidebar action that needs one to run against. */
  static any(): WeftPanel | null {
    return WeftPanel.current ?? WeftPanel.open.values().next().value ?? null;
  }

  /** The latest walk of the graph open on a repository, for its statistics tab; null when none is open. */
  static walkOf(root: string): Walk | null {
    return WeftPanel.open.get(root)?.walk ?? null;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly git: Git;
  private readonly repo: RepoInfo;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private loading: AbortController | null = null;
  private detailsLoading: AbortController | null = null;
  private readonly watcher: RepoWatcher;
  /**
   * What the last load was built from - the refs, and what git was halfway through - to tell a real
   * change from churn, and a change that needs a walk from one that needs only the banner redrawn.
   */
  private signature: Fingerprint | null = null;
  private signaturePromise: Promise<Fingerprint | null> | null = null;
  private search: Search | null = null;
  private dates: DateRange | null = null;
  /**
   * The working tree as of the last reload, so picking its row lists the files without a second
   * `git status` - the state was read a moment ago for the in-progress banner anyway.
   */
  private working: FileStatus[] = [];
  private fetchTimer: NodeJS.Timeout | null = null;
  /** A working-tree read waiting for a burst of events to go quiet. */
  private workingTimer: NodeJS.Timeout | null = null;
  /** Working-tree reads, one at a time and at most one queued - see `readWorkingNow`. */
  private readonly readWorking = coalesce(() => this.readWorkingNow());
  /**
   * What the last walk drew - the refs it named, null for all of them, and every commit it put on
   * screen - to tell a ref moving on screen from one moving where nobody can see it.
   */
  private drawnRefs: readonly string[] | null = null;
  private walked = new Set<string>();
  /** Walk only the mainline. A filter like any other: it decides which commits are on screen. */
  private firstParent = false;
  /** Walk only what the ticked refs have that no other ref does. */
  private onlyHere = false;

  /** A commit somebody asked to be shown, until the walk produces it or runs out. */
  private pendingReveal: string | null = null;
  /** Branches whose merges are all the graph is drawing, or empty for the ordinary graph. */
  private mergesFrom: readonly string[] = [];
  /** Whether this reveal has already widened the ticks once - see `widenForReveal`. */
  private widened = false;
  /** Not a filter: ordering hides nothing, so `clearFilters` leaves it alone the way it leaves sort. */
  private order: CommitOrder = 'date';
  private readonly filters: FilterSource;

  /** The latest walk, counted as it went: see `stats/tally.ts`. */
  private walk: Walk = { state: 'walking' };

  /** The branch the last ref list was sent with. */
  private headBranch: string | null = null;

  private readonly ui: ActionUi = {
    confirm: async (request) => {
      const choice = await vscode.window.showWarningMessage(
        request.title,
        { modal: true, detail: request.detail },
        request.confirmLabel,
      );

      return choice === request.confirmLabel;
    },

    input: async (request) => {
      const value = await vscode.window.showInputBox({
        title: request.title,
        prompt: request.placeholder,
        ...(request.value === undefined ? {} : { value: request.value }),
        validateInput: (entered) => request.validate?.(entered) ?? null,
      });

      // Dismissing the box is a cancel; an empty string is a deliberate empty answer, which some
      // actions treat as meaningful (a tag with no message is a lightweight tag).
      return value ?? null;
    },
    choose: async (request) => {
      const choice = await vscode.window.showWarningMessage(
        request.title,
        { modal: true, detail: request.detail },
        ...request.options,
      );

      return choice ?? null;
    },

    // withProgress hands back a Thenable; the registry deals in Promises so it can stay free of
    // any vscode types and remain runnable from a test. The cancellation token is translated to an
    // AbortSignal for the same reason - actions never see a vscode type.
    progress: async (title, work, cancellable = false) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Weft: ${title}`, cancellable },
        (_report, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return work(controller.signal);
        },
      ),
    notify: (message) => void vscode.window.setStatusBarMessage(`Weft: ${message}`, 4000),
    pick: async (request) => {
      const picked = await vscode.window.showQuickPick(
        request.items.map((item) => ({ label: item.label, description: item.description, picked: item.picked })),
        // Held open when the focus wanders: a list of a hundred branches is read, not glanced at.
        { title: request.title, placeHolder: request.placeholder, canPickMany: true, ignoreFocusOut: true },
      );

      return picked === undefined ? null : picked.map((item) => item.label);
    },
    log: (line) => output?.info(line),
    openUrl: async (url) => openUrl(url),
    remoteHosts: () => vscode.workspace.getConfiguration('weft').get<{ [host: string]: string }>('remoteHosts', {}),
    protectedBranches: () =>
      vscode.workspace
        .getConfiguration('weft')
        .get<string[]>('protectedBranches', [
          'main',
          'master',
          'develop',
          'release/*',
          'hotfix/*',
          'uat',
          'sit',
          'staging',
          'production',
        ]),
  };

  static show(
    extensionUri: vscode.Uri,
    git: Git,
    repo: RepoInfo,
    column: vscode.ViewColumn,
    filters: FilterSource,
  ): WeftPanel {
    const existing = WeftPanel.open.get(repo.root);
    if (existing !== undefined) {
      existing.panel.reveal(column);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Weft: ${repo.root.split('/').pop() ?? 'Graph'}`,
      column,
      {
        enableScripts: true,
        /*
         * On, and the comment it replaces is why: it said the graph "reloads in under a second, so
         * it is not worth the RAM".
         *
         * Both halves were guesses. Measured on a 78,282-commit repository, a reload was 2.3
         * seconds - and every switch away from the tab and back paid it, because VS Code tears the
         * webview down when it is hidden and the script's first act on return is to ask for one.
         * The RAM is 55.9 MB for that history, attributed per part in docs/design.md.
         *
         * A second and a half of blank pane on every tab switch, against 56 MB while the tab is
         * open. It also keeps the scroll position, the selection and the details pane, which the
         * reload threw away and never restored.
         */
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );

    /*
     * The extension's own icon on the tab, rather than the blank VS Code gives a webview.
     *
     * One file for both themes, and the marketplace icon rather than a monochrome mark: a tab icon
     * is drawn as an image, so the SVG's colours are what appear - which is why `weft.svg` cannot
     * be used here at all (it is `currentColor`, and nothing gives it one) and why this one can.
     * It carries its own dark ground, so it reads on either theme, and at sixteen pixels a small
     * coloured badge is easier to pick out of a row of tabs than two thin strokes.
     */
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');

    const weft = new WeftPanel(panel, extensionUri, git, repo, filters);
    WeftPanel.open.set(repo.root, weft);
    return weft;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    git: Git,
    repo: RepoInfo,
    filters: FilterSource,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.git = git;
    this.repo = repo;
    this.filters = filters;

    panel.webview.html = this.html(panel.webview);

    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => void this.onMessage(message),
      null,
      this.disposables,
    );

    panel.onDidChangeViewState(() => this.setActive(panel.active), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    const debounce = vscode.workspace
      .getConfiguration('weft')
      .get<number>('refreshDebounceMs', 600);

    this.watcher = new RepoWatcher(repo, () => void this.onRepositoryChanged(), debounce);
    this.startAutoFetch();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('weft.autoFetchMinutes')) {
          this.startAutoFetch();
        }
      }),
    );

    // The watcher sees `.git`, which is where refs move and is not where a file being saved shows
    // up. The working-tree row would otherwise sit stale until something else caused a reload.
    this.disposables.push(watchWorkingTree(repo.root, () => this.scheduleWorking()));

    /*
     * The watcher's first baseline: the refs as they are before the sidebar is pointed at this
     * repository and reads them.
     *
     * Before the sidebar's read, never after - and so is every baseline since: the watcher's, which it
     * reads before telling the sidebar, and an action's. The sidebar hears of refs only when the
     * watcher finds its baseline behind them, so a baseline read after the sidebar's own read can hold
     * a ref the sidebar never saw - a branch made or deleted in a terminal in between - and the
     * watcher's next look finds nothing to tell it. A walk once kept its own read of the refs as the
     * baseline, taken alongside the walk, and that is how a branch deleted in a terminal stayed in
     * Branches & Tags until another ref moved: after a walk for a filter that landed inside the
     * debounce, and after the watcher's own walk.
     */
    this.signaturePromise = repoFingerprint(git, repo).catch(() => null);
    void this.signaturePromise.then((value) => {
      this.signature = value;
    });

    this.setActive(true);
  }

  /**
   * A filesystem event fired. Confirm something the graph actually draws from moved before paying
   * for a reload - an editor saving a file inside .git, or git touching a lock, must not cost a
   * full re-walk of the history.
   */
  private async onRepositoryChanged(): Promise<void> {
    // A write in flight touches refs constantly. Its own reload comes at the end; reacting here as
    // well would reload the graph from the middle of a half-finished operation.
    if (WeftPanel.lock.isBusy(this.repo.root)) {
      return;
    }

    // The first baseline is read as the panel opens, and may still be in flight. Comparing against a
    // half-set baseline would either miss a change or invent one.
    await this.signaturePromise;

    let signature: Fingerprint;

    try {
      signature = await repoFingerprint(this.git, this.repo);
    } catch {
      return;
    }

    const previous = this.signature;
    this.signature = signature;

    // No baseline yet: this is the first look, and there is nothing to compare it with.
    if (previous === null) {
      return;
    }

    if (signature.refs !== previous.refs) {
      /*
       * First, and awaited: the sidebar hears of every branch whether or not the graph walks, and a
       * checkout moves the ticks - which are what the decision below, and the walk after it, read.
       */
      await this.filters.refsMoved();

      const next = this.filters.refs(this.repo.root);
      const drawn = next === null || this.drawnRefs === null ? null : new Set([...next, ...this.drawnRefs]);

      const onScreen = changesDrawing(previous.refs, signature.refs, {
        drawn,
        walked: this.walked,
        complete: this.loading === null,
        exclusive: this.onlyHere,
      });

      if (onScreen) {
        this.post({ type: 'reloading', reason: 'repository changed' });
        await this.reload();
      } else {
        // Nothing drawn moved. What does name the branch - the sidebar, which has re-read, and the
        // header's menu and counts, which come with the working tree - is all there is to redraw.
        await this.refreshWorking();
      }

      return;
    }

    /*
     * Only what git is halfway through changed - a merge that stopped on a conflict, started in a
     * terminal, moves no ref at all. So the banner and the working tree are drawn from a fresh read
     * of the state, and the history is left alone: nothing a walk would draw has moved, and a walk
     * to say "you are in the middle of a merge" is the whole history spent on one line of text.
     */
    if (signature.operation !== previous.operation) {
      await readRepoState(this.git, this.repo)
        .then((state) => this.postOperation(state))
        .catch(() => undefined);
    }

    /*
     * And the branch on screen, against the branch HEAD is on.
     *
     * The fingerprint above is read when a wake begins; the header is named by the redraw that
     * follows. A checkout landing between the two is drawn - the name that arrives is the new one -
     * while the baseline still holds the repository from before it. Checking the first branch out
     * again then matches that baseline exactly: nothing moved, said the watcher, and the header went
     * on naming a branch nobody was on until something else happened to move a ref.
     *
     * Measured before it was believed, on two branches at one commit: the checkout onto the second
     * posted a walk within a second, and the checkout back posted nothing at all for twenty. A pause
     * before that second checkout made it post within one, which is what said this was two reads of
     * different moments rather than anything wrong with the watching.
     *
     * Against what was drawn rather than against the baseline, because the baseline is the thing that
     * is wrong. And it costs no walk to put right: two branches at one commit draw the same graph, and
     * a branch anywhere else would have moved the fingerprint and been drawn above.
     */
    if (headBranchOf(signature) !== this.headBranch) {
      await this.refreshWorking();
    }
  }

  /**
   * Track which graph is in front, and mirror it into a context key so `Weft: Refresh` only
   * offers itself in the command palette when there is actually a graph to refresh.
   */
  private setActive(active: boolean): void {
    if (active) {
      WeftPanel.current = this;
      // The sidebar shows one repository at a time, and the one worth showing is the one being
      // looked at. Without this, opening a second graph leaves Branches & Tags on the first.
      this.filters.activated(this.repo);
    } else if (WeftPanel.current === this) {
      WeftPanel.current = null;
    }

    void vscode.commands.executeCommand(
      'setContext',
      'weft.graphVisible',
      WeftPanel.current !== null,
    );
  }

  /**
   * What to compare against when the graph is drawing every branch there is.
   *
   * There is no one side then, and `A...B` wants one: git marks the copies either side of a symmetric
   * difference, and "everything" is not a side - `--all` with `--left-only` was measured to print
   * nothing at all, which is the honest answer to a question that has no left in it.
   *
   * So the branch you are on, and what each remote calls its own default branch, which is the closest
   * thing git records to "where this work goes". That is the case this was found in: a graph drawing
   * everything, somebody standing on their own feature branch, and the copies sitting in the trunk -
   * where `HEAD` alone found nothing, the default branch found four against the remote test site and
   * thirteen against the local one.
   *
   * A copy that is on neither is not found, and that is the shape of this: with every branch drawn there
   * is no one history to be a copy *in*, so the two that can be named are named.
   */
  private async wholeRepositorySides(refNames: readonly string[]): Promise<string[]> {
    const sides = ['HEAD'];

    for (const remote of remotesIn(refNames).slice(0, 2)) {
      const head = await this.git
        .runRead(this.repo.root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
        .catch(() => '');

      if (head.trim().length > 0) {
        sides.push(head.trim());
      }
    }

    return sides;
  }

  /**
   * The commits in what this graph draws whose change is also on one of the branches the switch names.
   *
   * A cherry-pick leaves no record of where it came from - `-x` is a habit, not a rule, and in the
   * repository this was measured on nobody taking things out of the test site had it - so the only
   * thing that ties the two together is that the change is the same. git can say that by patch id, and
   * `--left-only --cherry-mark` says it about one side, which is the side that matters here: the commit
   * this graph draws is the copy, and the one it was copied from is over there with a sha of its own.
   *
   * **Which two sides** is the whole of it, and getting it wrong is silent - an empty set draws an empty
   * filter, which looks exactly like a repository where nobody has done this. It was `HEAD` against one
   * ref per name, and both halves of that were wrong:
   *
   * - The left side is what the graph draws, not what you have checked out. Standing on a feature branch
   *   while the graph draws the trunk, `HEAD` against the test site found nothing, because the copies
   *   are in the trunk and the feature branch has never seen them.
   * - The right side is every ref the name has. Measured on that repository: twelve against the local
   *   `uat`, which was 251 commits behind, and none against `origin/uat`, where the recent copies are.
   *
   * So: every drawn ref against every copy of every name, and the graph drawing everything is asked
   * about `HEAD`, which is the one case with nothing else to ask about. Capped, because this is a read
   * each - 0.9 seconds on that repository - and a graph with forty branches ticked would otherwise stop
   * to do arithmetic about all of them.
   */
  private async pickedFrom(drawn: readonly string[] | null): Promise<ReadonlyMap<string, string>> {
    const found = new Map<string, string>();

    if (this.mergesFrom.length === 0) {
      return found;
    }

    const refNames = this.filters.listRefs().map((ref) => ref.refName);
    const sides = drawn === null || drawn.length === 0 ? await this.wholeRepositorySides(refNames) : drawn;
    const pairs: [string, string, string][] = [];

    for (const name of this.mergesFrom) {
      for (const ref of refsFor(name, refNames)) {
        for (const side of sides) {
          pairs.push([side, ref, name]);
        }
      }
    }

    for (const [side, ref, name] of pairs.slice(0, PICK_READS)) {
      const walked = await this.git.runRead(this.repo.root, pickedArgs(side, ref)).catch(() => '');

      for (const sha of parsePicked(walked)) {
        // The name from the box rather than the ref it was resolved to: `uat` is what was asked about.
        found.set(sha, name);
      }
    }

    return found;
  }

  /** Throw away whatever is on screen and walk the history again. */
  refresh(): void {
    void this.reload();
  }

  /** The root of the repository this graph draws. */
  get root(): string {
    return this.repo.root;
  }

  /** Keep a walk's state, and tell whoever reads walks - the repository's statistics tab - that it moved. */
  private setWalk(walk: Walk): void {
    this.walk = walk;
    walkListener?.(this.repo.root);
  }

  /** Run an action that targets the repository rather than anything in the graph. */
  runRepoAction(id: string): void {
    void this.runAction(id, { kind: 'repo' });
  }

  /** Run an action against something the sidebar picked rather than something the graph did. */
  runTargetAction(id: string, target: Target): void {
    /*
     * Announced, unlike an action the graph itself asked for. A refusal is posted to the webview,
     * which is the right place for something the user right-clicked *in* - but somebody who
     * right-clicked in the sidebar may not have the graph in front of them at all, and an action
     * that declines into a panel nobody is looking at is indistinguishable from one that did
     * nothing.
     */
    void this.runAction(id, target, false, true);
  }

  /**
   * Bring the graph forward with the cursor on one commit.
   *
   * Sent twice, and not by mistake. A graph that is already showing the commit takes the first
   * one; a graph that has just been opened, or is forty thousand rows from that commit, has
   * nothing to put the cursor on yet - so the sha is held and sent again with the page that
   * carries it. A walk that ends without ever reaching it says so rather than doing nothing.
   */
  revealCommit(sha: string): void {
    this.panel.reveal(this.panel.viewColumn);
    this.pendingReveal = sha;
    this.widened = false;
    this.post({ type: 'reveal', sha });

    /*
     * Nothing is walking, and the walk that is on screen did not draw it.
     *
     * Both halves matter. A reveal is answered by the view if the commit is there and by the end of the
     * walk if one is running - and when neither is true, which is a graph sitting still, nothing
     * answered it at all: the click did nothing, said nothing, and left the reader looking at the same
     * screen. That is the ordinary case for anything naming a commit from outside the graph.
     */
    if (this.loading === null && !this.drew(sha)) {
      this.widenForReveal();
    }
  }

  /** Whether the walk on screen drew this commit, which is only ever known while the ticks narrow one. */
  private drew(sha: string): boolean {
    for (const drawn of this.walked) {
      if (drawn.startsWith(sha)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Show every branch, to find a commit that was asked for and is not on screen.
   *
   * Asking for a commit is asking to see it, so if what is hiding it is the ticks - a graph drawing one
   * branch, and a commit on somebody else's - the ticks are widened and the walk is done again, rather
   * than answering a click with a sentence about why it did nothing. A sha in a terminal, a line's
   * blame, a merge picked out of the test-branch report: none of them are about a branch the reader
   * happens to have ticked.
   *
   * Once, and only when the ticks are narrowing something. A date or an author filter can hide a commit
   * just as well and widening the ticks would not help, so that still gets the sentence - and a second
   * widening would be a loop, because the first one already showed everything there is.
   *
   * The walk that follows is the sidebar's: every reveal points it at this repository first, so the tick
   * changed here is one this graph is drawing, and the reload arrives through the filter change the way
   * it does when somebody clicks Show All themselves.
   */
  private widenForReveal(): boolean {
    /*
     * `refs` answering null is the graph drawing everything, and anything else is a set of ticks that
     * can hide a commit - including the default one, which is the branch you are on. `refsNarrowed` is
     * the wrong question here for exactly that reason: it asks whether the ticks differ from the
     * default, and a graph freshly opened on `main` is drawing one branch out of four hundred.
     */
    if (this.pendingReveal === null || this.widened || this.filters.refs(this.repo.root) === null) {
      return false;
    }

    this.widened = true;
    this.post({ type: 'reloading', reason: `showing every branch to find ${this.pendingReveal.slice(0, 8)}` });
    this.filters.setRefsPreset('all');
    return true;
  }

  /**
   * Show one file's history in the graph.
   *
   * The view sets its own search box rather than the panel setting a filter behind it: a graph
   * narrowed to a path while the box says something else is the disagreement the handshake exists
   * to prevent.
   */
  showFileHistory(path: string): void {
    this.panel.reveal(this.panel.viewColumn);
    this.post({ type: 'showHistory', path });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // The view is the authority here: it has just restored what the user last chose, and the
        // filters this panel is still holding belong to a webview that no longer exists.
        this.search = message.search;
        this.dates = message.dates;
        this.firstParent = message.firstParent;
        this.onlyHere = message.onlyHere;
        this.order = message.order;
        await this.reload();
        break;
      case 'refresh':
        await this.reload();
        break;
      case 'clearFilters':
        await this.clearFilters();
        break;
      case 'search':
        this.search = message.search;
        await this.reload();
        break;
      case 'dates':
        this.dates = message.range;
        await this.reload();
        break;
      case 'firstParent':
        this.firstParent = message.on;
        await this.reload();
        break;
      case 'onlyHere':
        this.onlyHere = message.on;
        await this.reload();
        break;
      case 'mergesFrom':
        this.mergesFrom = message.branches;
        await this.reload();
        break;
      case 'order':
        this.order = message.order;
        await this.reload();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage('Weft: copied', 2000);
        break;
      case 'selectCommit':
        await this.showDetails(message.sha);
        break;
      case 'selectUncommitted':
        commitFiles?.working(this.repo.root, this.working);
        break;
      case 'compare':
        await this.showComparison(message.from, message.to);
        break;
      case 'requestMenu':
        await this.showMenu(message.target, message.x, message.y);
        break;
      case 'runAction':
        await this.runAction(message.id, message.target);
        break;
      case 'refsPreset':
        /*
         * Straight through, like the ticks beside it: the sidebar fires its own filter event, which
         * is already wired to reload every open graph. Nothing to post back and nothing to wait
         * for - the reload that follows carries the new list with it.
         */
        this.filters.setRefsPreset(message.preset);
        break;
      case 'applyRefsPreset':
        // Straight through, like the presets beside it: the sidebar's filter event does the rest.
        this.filters.applyRefPreset(message.name);
        break;
      case 'saveRefsPreset':
        void vscode.commands.executeCommand('weft.saveRefPreset');
        break;
      case 'manageRefsPresets':
        void vscode.commands.executeCommand('weft.manageRefPresets');
        break;
      case 'setRefsVisible':
        /*
         * Straight through to the sidebar's own state. It fires the filter event, which is already
         * wired to reload every graph - so this posts nothing back and waits for nothing: the
         * reload that follows carries the new list with it.
         */
        this.filters.setRefsVisible(message.refNames, message.visible);
        break;
      case 'openConflict':
        await this.openConflict(message.path);
        break;
      case 'openTicket':
        await this.openTicket(message.text);
        break;
      default:
        break;
    }
  }

  /**
   * Whether an action is available depends on repository state - mid-rebase, already checked out,
   * a dirty tree - which the webview does not have. So the menu is built here, on demand, and the
   * click position rides along so it can open where the pointer is.
   */
  private async showMenu(target: Target, x: number, y: number): Promise<void> {
    try {
      const state = await readRepoState(this.git, this.repo);
      this.post({ type: 'menu', target, items: buildMenu(target, state), x, y });
    } catch (err) {
      void this.reportError(err);
    }
  }

  /**
   * Ask before anything that moves HEAD.
   *
   * Not for git's sake - a checkout that would overwrite work is refused by git itself - but for the
   * reader's. Rewriting a large worktree is a lot of files changing under whatever else is open, and
   * what is being named is a branch or a hash, the kind of argument you can be one character wrong
   * about. So it asks, with the one fact that decides it: how long since that commit was made.
   *
   * A checkout that detaches HEAD - onto a commit, or a tag - says so. New commits made there are on
   * no branch until one is made for them, which is the surprise worth a sentence.
   */
  private async confirmSwitch(target: Target): Promise<boolean> {
    if (target.kind !== 'ref' && target.kind !== 'commit') {
      return true;
    }

    const detached = target.kind === 'commit' || target.refKind === 'tag';
    const name = target.kind === 'commit' ? target.sha.slice(0, 8) : target.label;
    const moved = await this.refMoved(target.kind === 'commit' ? target.sha : target.refName);

    const detail = [
      target.kind === 'commit' ? target.subject : '',
      moved === null ? '' : `${target.kind === 'commit' ? 'Committed' : 'Last moved'} ${describeAge(moved)}.`,
      detached ? 'HEAD will be detached: new commits made there are on no branch until you create one.' : '',
    ].filter((line) => line.length > 0);

    const choice = await vscode.window.showWarningMessage(
      detached ? `Check out ${name} (detached)?` : `Check out ${name}?`,
      { modal: true, detail: detail.join('\n') },
      'Checkout',
    );

    return choice === 'Checkout';
  }

  /** When a revision's commit was made - a ref's tip, or a hash - in epoch ms, or null when git will not say. */
  private async refMoved(refName: string): Promise<number | null> {
    const out = await this.git
      .runRead(this.repo.root, ['log', '-1', '--format=%ct', refName])
      .catch(() => '');

    const seconds = Number(out.trim());
    return seconds > 0 ? seconds * 1000 : null;
  }

  /**
   * Run one action, holding the repository lock across read-decide-act.
   *
   * The lock covers the whole sequence rather than just the git call: the state an action checked
   * has to still be true when it acts, and the watcher must not reload the graph from underneath a
   * half-finished operation.
   */
  private async runAction(
    id: string,
    target: Target,
    retrying = false,
    announce = false,
  ): Promise<boolean> {
    const action = findAction(id);

    if (action === undefined) {
      return false;
    }

    try {
      const result = await WeftPanel.lock.run(this.repo.root, async () => {
        const state = await readRepoState(this.git, this.repo);
        const unavailable = action.unavailable(target, state);

        if (unavailable !== null) {
          const refusal = `${action.label(target)}: ${unavailable.toLowerCase()}`;
          this.post({ type: 'error', message: refusal });

          if (announce) {
            void vscode.window.showWarningMessage(`Weft: ${refusal}`);
          }

          return null;
        }

        /*
         * Asked here, where every action passes whoever started it: the graph's messages, the
         * sidebar's commands and the remedies all arrive in this function. It used to be asked
         * where the graph's messages come in, and the sidebar sends none - its Checkout called
         * straight through and ran without a question, while 0.8.0's notes said checking out always
         * asked.
         *
         * After the refusal, so checking out the branch you are on says so instead of first asking
         * whether you are sure; and not on the retry, which the user has already answered once.
         */
        if (action.movesHead === true && !retrying && !(await this.confirmSwitch(target))) {
          return null;
        }

        const context: ActionContext = { git: this.git, repo: this.repo, state, target, ui: this.ui };

        if (!(await confirmIfNeeded(action, context))) {
          return null;
        }

        // Where we were, so the follow-up message can say how to get back. git keeps this in the
        // reflog too, but only someone who already knows that would go looking.
        const before = state.head;
        const outcome = await action.run(context);

        // And where HEAD is now, because a way back is only worth offering if HEAD moved. Read here,
        // inside the lock, before anything else has had the chance to move it.
        const after = outcome.ran
          ? (await this.git.runRead(this.repo.root, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => '')).trim() ||
            null
          : before;

        return { outcome, before, after };
      });

      if (result === null) {
        return false;
      }

      /*
       * Refused once it had looked - what `unavailable` says before anything runs, from an action that
       * had to ask git to know it: which server a remote is, whether a branch was ever pushed. Said the
       * way a refusal is said, and nothing is walked, because nothing moved.
       */
      if (result.outcome.refused === true) {
        const reason = result.outcome.message;
        const refusal = `${action.label(target)}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
        this.post({ type: 'error', message: refusal });

        if (announce) {
          void vscode.window.showWarningMessage(`Weft: ${refusal}`);
        }

        return false;
      }

      /*
       * Backed out of the action's own question - a name box dismissed, a choice left unmade. Nothing
       * moved, so nothing is walked: read as a run, it walked the whole history again to draw what
       * was already on screen, and the status bar said "Weft:" with nothing after it but "(was …)".
       *
       * Only when there is nothing to say. An action that did not run and says why has news, and one
       * kind of news is that the graph is behind: a stash that has moved since it was drawn. Walking
       * again is how the graph catches up.
       */
      if (!result.outcome.ran && result.outcome.message.length === 0) {
        return false;
      }

      // The watcher's baseline, read before the sidebar reads the refs - see the constructor.
      const baseline = await repoFingerprint(this.git, this.repo).catch(() => null);

      if (baseline !== null) {
        this.signature = baseline;
      }

      // Awaited: the walk reads the ticks, and a checkout moves them.
      await this.filters.refsMoved();
      await this.reload();

      /*
       * Only when HEAD moved. Deleting a branch or a tag leaves HEAD where it was, and those messages
       * already end in the deleted ref's own "(was …)" - so the status line read two shas, the second
       * of them where HEAD still was.
       */
      const back =
        result.before === null || result.after === result.before ? '' : `  (was ${result.before.slice(0, 8)})`;
      void vscode.window.setStatusBarMessage(`Weft: ${result.outcome.message}${back}`, 5000);
      return result.outcome.ran;
    } catch (err) {
      // One retry, never two: an offer to stash and retry that fails the same way must not become
      // a loop of dialogs the user has to fight their way out of.
      await this.reportError(err, retrying ? null : () => this.runAction(id, target, true, announce));
      return false;
    }
  }

  private async reportError(err: unknown, retry: (() => Promise<unknown>) | null = null): Promise<void> {
    const mapped = await explainStaleLock(mapGitError(err), this.repo.root);
    const detail = mapped.paths.length === 0 ? '' : `\n\n${mapped.paths.map((p) => `  ${p}`).join('\n')}`;

    output?.warn(`${mapped.message}\n${mapped.raw}`);
    this.post({ type: 'error', message: mapped.message });

    // git usually does say what to do about a failure; the whole point of mapping errors was to
    // keep that advice instead of losing it in a wall of text. A remedy with no button is advice
    // thrown away twice.
    const offered = mapped.remedies.filter(
      (remedy) =>
        (remedy !== Remedy.StashAndRetry && remedy !== Remedy.Retry) || retry !== null,
    );

    const choice = await vscode.window.showWarningMessage(
      mapped.message + detail,
      { modal: mapped.paths.length > 0 },
      ...offered.map((remedy) => REMEDY_LABELS[remedy]),
    );

    const chosen = offered.find((remedy) => REMEDY_LABELS[remedy] === choice);

    if (chosen !== undefined) {
      await this.applyRemedy(chosen, retry);
    }
  }

  private async applyRemedy(remedy: Remedy, retry: (() => Promise<unknown>) | null): Promise<void> {
    switch (remedy) {
      case Remedy.ShowLog:
        output?.show();
        return;

      case Remedy.ResolveConflicts:
        // The banner above the graph already lists them, each a link into the merge editor.
        this.panel.reveal();
        return;

      case Remedy.AbortOperation:
        await this.runAction('weft.abortOperation', { kind: 'repo' });
        return;

      case Remedy.Fetch:
        await this.runAction('weft.fetch', { kind: 'repo' });
        return;

      case Remedy.Retry:
        // The same action, unchanged. Offered only where the failure was somebody else's timing
        // rather than the repository's state, so there is nothing to put right in between.
        await retry?.();
        return;

      case Remedy.StashAndRetry:
        // Only retry if the stash actually happened - otherwise the retry hits the same wall.
        if (await this.runAction('weft.stashPush', { kind: 'repo' })) {
          await retry?.();
        }

        return;

      default:
        return;
    }
  }

  /** Whether anything at all is narrowing the walk, wherever it was set. */
  private isFiltered(): boolean {
    return (
      this.search !== null ||
      this.dates !== null ||
      this.firstParent ||
      this.onlyHere ||
      this.mergesFrom.length > 0 ||
      this.filters.refsNarrowed(this.repo.root) ||
      this.filters.authorPicks(this.repo.root).length > 0
    );
  }

  /**
   * Drop every filter at once: the search, the date range, and both sidebar views.
   *
   * The sort is deliberately left alone. It is an ordering rather than a filter - nothing is hidden
   * by it - and it has its own way back in the title bar.
   */
  async clearFilters(): Promise<void> {
    this.search = null;
    this.dates = null;
    this.firstParent = false;
    this.onlyHere = false;
    this.mergesFrom = [];
    this.filters.clear();

    // Put the boxes back before the walk rather than after it, so nothing on screen is claiming a
    // filter that is no longer being applied.
    this.post({ type: 'filtersCleared' });
    await this.reload();
  }

  /**
   * Load one commit's message and file list. Selection follows the arrow keys, so a held-down key
   * would otherwise queue a `git show` per row - each new request cancels the one before it.
   */
  private async showDetails(sha: string): Promise<void> {
    this.detailsLoading?.abort();
    const controller = new AbortController();
    this.detailsLoading = controller;

    try {
      const details = await loadCommitDetails(this.git, this.repo, sha, controller.signal);

      if (!controller.signal.aborted) {
        // The pane gets the commit; the sidebar gets what it changed. Splitting them here is what
        // keeps a 500-file merge from being structured-cloned into the webview on every keypress.
        const { files: _files, ...info } = details;

        this.post({ type: 'details', details: info });
        commitFiles?.show(this.repo.root, details);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (this.detailsLoading === controller) {
        this.detailsLoading = null;
      }
    }
  }

  /**
   * What two commits differ by.
   *
   * It shares `detailsLoading` with the single-commit path on purpose: both answer "what is
   * selected", only one of them can be true at a time, and ctrl-clicking down a column would
   * otherwise leave a `git diff` running for every pair passed through on the way.
   */
  private async showComparison(from: CompareEnd, to: CompareEnd): Promise<void> {
    this.detailsLoading?.abort();
    const controller = new AbortController();
    this.detailsLoading = controller;

    try {
      // By what each end names: a branch is compared as it is now, and comes back as the commit that
      // was - which is what the rows are marked by.
      const commitOf = async (end: CompareEnd): Promise<string> =>
        (
          await this.git.runRead(
            this.repo.root,
            ['rev-parse', '--verify', '--end-of-options', `${end.rev}^{commit}`],
            { signal: controller.signal },
          )
        ).trim();

      const [fromSha, toSha] = await Promise.all([commitOf(from), commitOf(to)]);
      const comparison = await compareCommits(this.git, this.repo, fromSha, toSha, controller.signal);

      if (!controller.signal.aborted) {
        this.post({
          type: 'comparison',
          from: { rev: from.rev, label: from.label, sha: fromSha, drawn: this.drawing(from.rev) },
          to: { rev: to.rev, label: to.label, sha: toSha, drawn: this.drawing(to.rev) },
          files: comparison.files.length,
          onlyFrom: comparison.onlyFrom,
          onlyTo: comparison.onlyTo,
          onlyFromCommits: comparison.onlyFromCommits,
          onlyToCommits: comparison.onlyToCommits,
        });

        commitFiles?.compared(this.repo.root, comparison, { from: from.label, to: to.label });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (this.detailsLoading === controller) {
        this.detailsLoading = null;
      }
    }
  }

  /**
   * Open a clicked ticket id where its tracker keeps it. The address is built here, from the text
   * alone - so nothing the view sends, and nothing a commit message says, chooses where it goes.
   */
  private async openTicket(text: string): Promise<void> {
    const { links } = readTicketLinks(vscode.workspace.getConfiguration('weft').get<unknown[]>('ticketLinks', []));
    const url = ticketUrl(links, text);

    if (url !== null) {
      await openUrl(url);
    }
  }

  /**
   * Hand a conflicted file to VS Code. Its merge editor opens by itself for a file with conflict
   * markers, and it is better at resolving them than anything that would fit in the graph.
   */
  private async openConflict(path: string): Promise<void> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.repo.root), path);
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  /**
   * The working tree, and where the branch it sits on stands.
   *
   * Both come out of the same `git status -b`, and both change for the same reasons, so they travel
   * together rather than as two messages that could disagree with each other.
   */
  private postWorking(tree: WorkingTree): void {
    this.working = tree.files;

    this.post({
      type: 'working',
      total: tree.files.length,
      staged: tree.files.filter((file) => file.staged).length,
      unstaged: tree.files.filter((file) => file.unstaged).length,
      untracked: tree.files.filter((file) => file.untracked).length,
      conflicted: tree.files.filter((file) => file.conflicted).length,
      branch: tree.branch,
      upstream: tree.upstream,
      fetchedAt: tree.fetchedAt,
    });

    this.postRefs(tree.branch);
  }

  /**
   * The ref list, for the header's branch menu.
   *
   * Read from the same source the walk reads its filter from, at the same moment - a menu showing
   * a tick that the next reload disagrees with is worse than no menu.
   */
  private postRefs(branch: string | null): void {
    // Kept, because a reorder sends the list again and the branch travels with it.
    this.headBranch = branch;
    this.post({
      type: 'refs',
      branch,
      refs: this.filters.listRefs(),
      presets: this.filters.refPresets(),
      // The menu folds as the sidebar does, so the setting goes along with the list it folds.
      folders: vscode.workspace.getConfiguration('weft').get<BranchFolders>('branchFolders', 'auto'),
    });
  }

  /**
   * A working-tree event from the git extension. However close together they came, each one was a
   * `git status` of our own, several of them side by side - so wait for 150 ms of quiet and read
   * once for the lot.
   */
  private scheduleWorking(): void {
    if (this.workingTimer !== null) {
      clearTimeout(this.workingTimer);
    }

    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      void this.refreshWorking();
    }, 150);
  }

  /**
   * Re-read the working tree without touching the history.
   *
   * Saving a file changes nothing a walk would produce differently, so re-walking would be paying
   * for the whole graph to move one row's worth of text.
   */
  private async refreshWorking(): Promise<void> {
    /*
     * Not while this repository is being written to.
     *
     * Reading looks harmless and on Windows is not. git opens a file without granting the right to
     * delete it, and moves a ref by renaming a lock over the old one - so a `git status` that
     * happens to have .git/HEAD open at the wrong instant turns a checkout into "unable to write
     * symref for HEAD: Permission denied", with the working tree already swapped over and the
     * branch left behind.
     *
     * Weft's own watcher and its auto-fetch already stand back for a write in flight; this path
     * did not, and it is the one the git extension fires *during* a checkout, when the churn it
     * watches for is our own. Nothing is lost by waiting: every write ends in a reload, which
     * re-reads the working tree anyway.
     */
    if (WeftPanel.lock.isBusy(this.repo.root)) {
      return;
    }

    await this.readWorking();
  }

  /**
   * One read of the working tree, drawn. Reached only through `readWorking`, which runs these one at
   * a time: a request while one is going gets one more after it, however many arrived, and never a
   * second alongside. Auto-fetch asks without waiting for a quiet moment, and on a large repository
   * each `git status` is the better part of a second.
   */
  private async readWorkingNow(): Promise<void> {
    // Asked again for a run that was queued: a write may have begun while the one before it read.
    if (WeftPanel.lock.isBusy(this.repo.root)) {
      return;
    }

    const tree = await readWorkingTree(this.git, this.repo).catch(() => null);

    if (tree !== null) {
      this.postWorking(tree);
    }
  }

  /**
   * Tell the view what git is halfway through. Sent on every reload rather than only when it
   * changes, because the view is rebuilt from scratch each time the tab is shown.
   */
  private postOperation(state: Awaited<ReturnType<typeof readRepoState>>): void {
    this.postWorking(state);

    this.post({
      type: 'operation',
      operation: state.operation,
      description: describeOperation(state.operation) ?? '',
      conflicted: state.files.filter((file) => file.conflicted).map((file) => file.path),
      // An allow-list, not a deny-list: this banner is "you are mid-rebase, here is the way out",
      // so anything that is not a way out has no business appearing in it. Selecting by exclusion
      // is how Force Push turned up here.
      controls: buildMenu({ kind: 'repo' }, state).filter((item) => item.group === 'operation'),
    });
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async reload(): Promise<void> {
    // A refresh landing mid-walk must stop the old one, or two loaders race to append rows.
    this.loading?.abort();
    const controller = new AbortController();
    this.loading = controller;
    this.walked = new Set();

    const config = vscode.workspace.getConfiguration('weft');

    this.post({ type: 'reset', filtered: this.isFiltered() });
    this.post({
      type: 'init',
      repoName: this.repo.root.split('/').pop() ?? this.repo.root,
      repoRoot: this.repo.root,
      rowHeight: config.get<number>('rowHeight', 24),
      authorColors: config.get<boolean>('authorColors', true),
      kind: describe(this.repo),
      ticketPatterns: readTicketLinks(config.get<unknown[]>('ticketLinks', [])).links.map((link) => link.pattern),
    });

    const loader = new HistoryLoader(this.git, this.repo);
    const started = Date.now();

    // Read once: the walk is bounded by it and the message at the end has to say whether it was.
    const limit = config.get<number>('maxCommits', 250_000);

    // Counted as the pages go past, for the statistics tab, rather than asked of git a second time - with the
    // commits weft.statistics.excludeMessages names counted apart, since they are left out of the charts only.
    const exclusions = readExclusions(config.get<unknown[]>('statistics.excludeMessages', []));
    const tally = new CommitTally(exclusions.patterns);
    this.setWalk({ state: 'walking' });

    // Only the newest stash is a ref, so the rest have to be named by SHA or the walk never sees
    // them. Cheap enough to re-read on every reload; a repository has a handful, not thousands.
    const stashList = await listStashes(this.git, this.repo, controller.signal).catch(() => []);
    const stashes = new Map(stashList.map((stash) => [stash.sha, stash.name]));

    /*
     * Asked only when there is a lower bound to place, and remembered after the first time - a
     * repository with no date filter never pays for the question at all.
     */
    const dates = dateArgs(
      this.dates,
      this.dates?.since == null ? false : await this.git.atLeast(2, 37),
    );

    /*
     * Alongside the history, not before it.
     *
     * This feeds one thing - the banner that says git is mid-rebase - and the comment here used to
     * say the reader should be told "while the walk is still running, not once it finishes".
     * Awaiting it did the opposite: the banner arrived before the walk *started*, and the walk
     * started 809ms late, because `git status` on a 38,000-file worktree is the slowest thing
     * either of them does. Firing it and posting when it lands is what that sentence describes.
     */
    void readRepoState(this.git, this.repo, controller.signal)
      .then((state) => this.postOperation(state))
      .catch(() => undefined);

    const drawnRefs = this.filters.refs(this.repo.root);
    this.drawnRefs = drawnRefs;

    // After the refs are known, because which of them are drawn is one of the two sides it compares.
    const picked = await this.pickedFrom(drawnRefs);

    try {
      await loader.load(
        (page) => {
          if (controller.signal.aborted) {
            return;
          }

          tally.add(page.commits);

          const rows: Row[] = page.commits.map((c) => {
            const stash = stashes.get(c.sha);
            const merged = this.mergesFrom.length === 0 ? null : tookTestBranch(c.subject, this.mergesFrom);
            const copied = picked.get(c.sha);

            /*
             * Why this row is here, for the filter that is drawing it. A merge first: a commit can be
             * both - a merge of the test site whose change also matches something over there - and what
             * it did is the merge.
             */
            const cameFrom =
              merged !== null
                ? { branch: merged.branch, how: 'merge' as const }
                : copied === undefined
                  ? null
                  : { branch: copied, how: 'copy' as const };

            return {
              sha: c.sha,
              subject: c.subject,
              author: c.author,
              date: c.authorDate,
              refs: c.refs,
              isHead: c.isHead,
              ...(stash === undefined ? {} : { stash }),
              ...(cameFrom === null ? {} : { cameFrom }),
            };
          });

          this.post({ type: 'page', rows, delta: page.delta });

          // Not kept when everything is drawn: then every ref that moves is on screen anyway.
          if (drawnRefs !== null) {
            for (const row of rows) {
              this.walked.add(row.sha);
            }
          }

          // The page that carries it is the first moment the view can act on it.
          if (
            this.pendingReveal !== null &&
            rows.some((row) => row.sha.startsWith(this.pendingReveal as string))
          ) {
            this.post({ type: 'reveal', sha: this.pendingReveal });
            this.pendingReveal = null;
          }
        },
        {
          /*
           * Both from the settings, which is new for one of them: `pageSize` was declared in the
           * manifest, described as the thing you wait for on open, and read by nothing at all.
           * Its declared default was 2000 while the code had 500 written into it, so the number
           * anybody read was not even the number in use.
           */
          batchSize: config.get<number>('pageSize', 500),
          maxCommits: limit,
          firstParentOnly: this.firstParent,
          onlyHere: this.onlyHere,
          order: this.order,
          /*
           * The switch's whole half is `keep`, and none of it can be given to git.
           *
           * Which merges took one of these branches somewhere is read from the message, and no `--grep`
           * says it - a second `--grep` would be ORed with the search box's own rather than intersected
           * with it, and the search box's regex and ignore-case switches are flags on the whole command
           * and would change what a pattern of ours meant. Which commits came across as copies is a set
           * of shas worked out before the walk, from patch ids.
           *
           * `--merges` was here while this drew merges alone, and had to go when it stopped: a commit
           * picked across is not a merge, and the walk that has to see it is the whole walk.
           */
          filters: filterArgs(this.search, this.filters.authorPicks(this.repo.root), dates),
          ...(this.mergesFrom.length === 0
            ? {}
            : {
                keep: (commit: { sha: string; subject: string }) =>
                  tookTestBranch(commit.subject, this.mergesFrom) !== null || picked.has(commit.sha),
              }),
          refs: drawnRefs,
          stashes,
        },
        controller.signal,
      );

      if (!controller.signal.aborted) {
        /*
         * Say when the walk was cut short.
         *
         * `--max-count` stops git at N and exits 0, so a truncated history is indistinguishable
         * from a complete one: root commits missing, lanes that never close, and a number at the
         * bottom that reads like the whole repository. Reaching the limit is what happened whether
         * or not there was more, which is what the line says.
         */
        this.post({
          type: 'done',
          total: loader.rowCount,
          elapsedMs: Date.now() - started,
          truncated: loader.rowCount >= limit,
        });

        this.setWalk({
          state: 'done',
          tally,
          facts: {
            truncated: loader.rowCount >= limit,
            limit,
            scope: describeScope({
              refs: drawnRefs,
              search: this.search,
              authors: this.filters.authorPicks(this.repo.root).length,
              dates: this.dates,
              firstParent: this.firstParent,
              onlyHere: this.onlyHere,
            }),
            dated: dates.length > 0,
            excludeRules: exclusions.rules,
            unreadableRules: exclusions.unreadable,
          },
        });

        // The walk finished and never produced it - see `widenForReveal`, which is the first thing to try.
        if (this.pendingReveal !== null && !this.widenForReveal()) {
          this.post({
            type: 'error',
            message: this.widened
              ? `${this.pendingReveal.slice(0, 8)} is not in this graph, with every branch shown. A date or an author filter is keeping it out.`
              : `${this.pendingReveal.slice(0, 8)} is not in this graph. A date or an author filter is keeping it out.`,
          });

          this.pendingReveal = null;
          this.widened = false;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.post({ type: 'error', message });
        this.setWalk({ state: 'failed', message });
      }
    } finally {
      if (this.loading === controller) {
        this.loading = null;
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'main.js'),
    );
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'style.css'));
    const n = nonce();

    // connect-src 'none' is worth stating outright: Weft never makes a network request, and the
    // policy should be able to prove that rather than asking to be trusted on it.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${n}'; connect-src 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style.toString()}" rel="stylesheet">
<title>Weft</title>
</head>
<body>
${BODY_MARKUP}
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  /**
   * Fetch on a timer, if asked to.
   *
   * Off by default, and deliberately: fetching is the one thing here that leaves the machine, and
   * doing it unasked is a decision for the person whose network it is. VS Code's own `git.autofetch`
   * does the same job, and Weft picks up whatever it does - the watcher sees the refs move.
   */
  private startAutoFetch(): void {
    if (this.fetchTimer !== null) {
      clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }

    const minutes = vscode.workspace
      .getConfiguration('weft')
      .get<number>('autoFetchMinutes', 0);

    if (minutes <= 0) {
      return;
    }

    this.fetchTimer = setInterval(() => void this.autoFetch(), minutes * 60_000);
  }

  /**
   * One quiet fetch.
   *
   * Quiet in both directions: no progress notification, because nobody asked for this one; and no
   * error popup, because every reason a background fetch fails - offline, a VPN, a credential
   * helper that has forgotten - is something the user finds out the moment they ask for one
   * themselves. `GIT_TERMINAL_PROMPT=0` is set for every command Weft runs, so the worst case is
   * a failure rather than a child process waiting forever on a password nobody can type.
   */
  private async autoFetch(): Promise<void> {
    if (WeftPanel.lock.isBusy(this.repo.root) || this.loading !== null) {
      return;
    }

    try {
      /*
       * Inside the lock, because `--prune` deletes remote-tracking refs. This is a write.
       *
       * The check above is a courtesy - do not start one while the user is doing something - and
       * on its own it is check-then-act: a checkout beginning a moment later saw nothing in its way
       * and ran alongside a fetch rewriting refs underneath it. On Windows that is the
       * `unable to write symref for HEAD` failure this extension already has a remedy for.
       *
       * A fetch somebody asked for has always queued behind the lock. One nobody asked for has no
       * business being the exception.
       */
      await WeftPanel.lock.run(this.repo.root, () =>
        this.git.runNetwork(this.repo.root, ['fetch', '--all', '--prune', '--quiet']),
      );
    } catch (err) {
      output?.warn(`auto-fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    /*
     * Refs that moved wake the watcher, which reloads on its own. Refs that did not still need this:
     * the fetch itself is news, because it is what the ahead/behind counts are true as of.
     */
    await this.refreshWorking();
  }

  private dispose(): void {
    this.loading?.abort();

    if (this.fetchTimer !== null) {
      clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }

    if (this.workingTimer !== null) {
      clearTimeout(this.workingTimer);
      this.workingTimer = null;
    }

    this.detailsLoading?.abort();
    this.watcher.dispose();
    WeftPanel.open.delete(this.repo.root);
    // Its statistics tab, if one is open, has no walk to show any more.
    walkListener?.(this.repo.root);
    this.setActive(false);

    // With no graph left to select in, the file list is showing a commit nobody can point at.
    if (WeftPanel.open.size === 0) {
      commitFiles?.clear();
    }

    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
