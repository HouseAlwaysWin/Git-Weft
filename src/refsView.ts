/**
 * The Branches & Tags sidebar: which refs the graph should draw.
 *
 * It is a section in Source Control rather than an Activity Bar icon of its own - one place for the
 * repository, next to the changes list, rather than two. A filter is the one piece of Weft that
 * genuinely wants to stay on screen while you work, rather than living in a dropdown above the
 * graph that has to be reopened every time.
 *
 * Unchecking refs narrows `git log` to the ones left, which is a real filter rather than a display
 * trick: a repository with two hundred `origin/dependabot/*` branches stops *walking* them.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { describeAge } from './git/blame.ts';

interface Group {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
}

interface Ref {
  readonly kind: 'ref';
  readonly group: Group;
  /** Full ref name, e.g. `refs/remotes/origin/main` - what git is given. */
  readonly refName: string;
  /** What the user reads, e.g. `origin/main`. */
  readonly label: string;
  readonly isHead: boolean;
  /**
   * When the ref last moved, epoch milliseconds, or 0 for a ref that will not say.
   *
   * The committer date rather than the author's: the question it answers is "has anybody touched
   * this branch lately", and rebasing a year-old commit onto today is a branch that moved today.
   */
  readonly updated: number;
}

type Node = Group | Ref;

/** What the list is sorted by. */
export type RefOrder = 'name' | 'recent';

const GROUPS: Group[] = [
  { kind: 'group', id: 'heads', label: 'Local Branches', prefix: 'refs/heads/' },
  { kind: 'group', id: 'remotes', label: 'Remote Branches', prefix: 'refs/remotes/' },
  { kind: 'group', id: 'tags', label: 'Tags', prefix: 'refs/tags/' },
];

export class RefsProvider implements vscode.TreeDataProvider<Node> {
  private readonly git: Git;
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  private readonly filterChanged = new vscode.EventEmitter<void>();

  private repo: RepoInfo | null = null;
  private refs: Ref[] = [];
  private view: vscode.TreeView<Node> | null = null;
  private query = '';

  /**
   * List only the refs that are ticked.
   *
   * The other half of the same problem the text filter solves. Once a handful of refs out of
   * fourteen hundred are ticked, the ticks are the answer to "what am I looking at" - and finding
   * them again means scrolling past one thousand three hundred that are not. This hides the rest
   * from the *listing* only; nothing about what the graph walks changes.
   */
  private tickedOnly = false;

  /**
   * How the list is ordered.
   *
   * By name to begin with, because a name is what you came looking for and alphabetical is how you
   * find one. By most recently moved is the other question a list of a hundred and fifty branches
   * raises - which of these is anybody still working on - and it puts the answer at the top instead
   * of scattered down the list beside the names.
   */
  private order: RefOrder = 'name';

  /**
   * Refs the user has switched off. Storing the *hidden* set rather than the visible one means a
   * branch created after the last refresh shows up by default, which is the behaviour that does not
   * surprise anyone.
   */
  private hidden = new Set<string>();

  /**
   * The unticked refs of every repository this session has looked at, keyed by root.
   *
   * Two reasons it is not one set. Switching tabs between two graphs and back would otherwise
   * discard whatever you had unticked in the first, which is work. And the panels ask this view
   * what to walk *by root* - a set belonging to one repository, handed to another, names refs that
   * do not exist there and empties its graph.
   */
  private readonly hiddenByRepo = new Map<string, Set<string>>();

  /**
   * Whether the ticks are still the default rather than a set the user has chosen.
   *
   * A repository opens showing the branch you are on and nothing else. Drawing every ref is a walk
   * of the whole history to answer a question nobody asked - on a clone with fourteen hundred refs
   * it is seconds of git, and a graph so wide that the branch you came to look at is one lane in a
   * bundle of hundreds.
   *
   * While this holds the ticks are recomputed from HEAD on every reload. The first tick the user
   * moves makes the set theirs and stops the following; Clear Filters hands it back, and so does a
   * checkout - see `head`.
   */
  private following = true;

  /** Whether each repository was still on the default, alongside `hiddenByRepo`. */
  private readonly followingByRepo = new Map<string, boolean>();

  /**
   * The ref HEAD was on when the refs were last read, so a checkout can be told from a refresh.
   *
   * Switching branch puts the ticks back to the default, whatever they were - a hand-picked set
   * included. "Which branches am I looking at" and "which branch am I on" are the same question
   * often enough that a graph still showing the branch you left is a graph showing the wrong
   * thing, and the answer to it is a checkout away rather than somewhere in a list of fourteen
   * hundred.
   */
  private head: string | null = null;

  /** Where HEAD was per repository, so coming back to one is not read as a checkout. */
  private readonly headByRepo = new Map<string, string | null>();

  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChangeFilter = this.filterChanged.event;

  constructor(git: Git) {
    this.git = git;
  }

  /** Point the view at a repository and reload its refs. */
  async setRepository(repo: RepoInfo | null): Promise<void> {
    if (repo?.root === this.repo?.root) {
      await this.reload();
      return;
    }

    // Put away under the repository being left, before `repo` moves - filing the outgoing set
    // under the incoming root hands one repository's ref names to another, which is the thing the
    // per-repository map exists to prevent.
    if (this.repo !== null) {
      this.hiddenByRepo.set(this.repo.root, this.hidden);
      this.followingByRepo.set(this.repo.root, this.following);
      this.headByRepo.set(this.repo.root, this.head);
    }

    this.repo = repo;
    // Kept rather than cleared: coming back to a graph should find it as you left it.
    this.hidden = this.hiddenByRepo.get(repo?.root ?? '') ?? new Set<string>();
    this.following = this.followingByRepo.get(repo?.root ?? '') ?? true;
    this.head = this.headByRepo.get(repo?.root ?? '') ?? null;
    await this.reload();
  }

  /**
   * The refs the graph should walk, or null for "everything" - which lets the caller use `--all`
   * and skip listing hundreds of refs on the command line.
   */
  /** Which repository this view is showing, so a caller can ask it the right question. */
  get repoRoot(): string | null {
    return this.repo?.root ?? null;
  }

  visibleRefs(root: string): string[] | null {
    /*
     * Only the repository this view is showing.
     *
     * Every open graph reloads when a tick moves, and each asks what to walk. Answering with this
     * repository's refs for somebody else's would hand a graph a list of names that do not exist in
     * it - which git reads as "walk nothing".
     */
    if (this.repo === null || this.repo.root !== root || this.hidden.size === 0) {
      return null;
    }

    return this.refs.filter((ref) => !this.hidden.has(ref.refName)).map((ref) => ref.refName);
  }

  /**
   * Whether the ticks are narrowing anything the default would not.
   *
   * Not the same question as `visibleRefs` returning a list. The default narrows too - one branch
   * out of fourteen hundred - and counting that as a filter would light "clear filters" on a graph
   * nobody has filtered, on every repository, forever.
   */
  isNarrowed(root: string): boolean {
    return this.repo?.root === root && !this.following && this.hidden.size > 0;
  }

  /**
   * The ticks a repository opens with: the branch HEAD is on, and nothing else.
   *
   * With HEAD detached, or on a branch with no commits yet, no ref is marked - and hiding every
   * ref leaves git walking nothing at all, which looks exactly like a broken graph. Everything,
   * then, until there is a branch to follow.
   */
  private applyDefault(): void {
    const head = this.refs.find((ref) => ref.isHead);

    this.hidden =
      head === undefined
        ? new Set<string>()
        : new Set(
            this.refs.filter((ref) => ref.refName !== head.refName).map((ref) => ref.refName),
          );
  }

  async reload(): Promise<void> {
    const repo = this.repo;

    if (repo === null) {
      this.refs = [];
      this.changed.fire(undefined);
      return;
    }

    try {
      const out = await this.git.runRead(repo.root, [
        'for-each-ref',
        // One field more, and no second process: the age comes off the same walk of the refs.
        '--format=%(refname)%00%(HEAD)%00%(committerdate:unix)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ]);

      this.refs = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          const [refName = '', head = '', updated = ''] = line.split('\x00');
          const group = GROUPS.find((g) => refName.startsWith(g.prefix));

          if (group === undefined) {
            return [];
          }

          const label = refName.slice(group.prefix.length);

          // origin/HEAD is a symbolic alias, not something you can meaningfully filter on.
          if (group.id === 'remotes' && label.endsWith('/HEAD')) {
            return [];
          }

          return [
            {
              kind: 'ref',
              group,
              refName,
              label,
              isHead: head === '*',
              // Empty for an annotated tag, whose date is the tagger's and lives in another field.
              updated: Number(updated) > 0 ? Number(updated) * 1000 : 0,
            } satisfies Ref,
          ];
        });
    } catch {
      this.refs = [];
    }

    /*
     * A checkout puts the ticks back to the default.
     *
     * Only a checkout: this runs on every ref change - a fetch, a commit, a branch deleted - and
     * re-arming on any of those would undo a hand-picked set for reasons nobody would connect to
     * what they had just done. HEAD moving to a different ref is the one that means "I am looking
     * at something else now".
     */
    const head = this.refs.find((ref) => ref.isHead)?.refName ?? null;

    if (head !== this.head) {
      this.head = head;
      this.following = true;
    }

    if (this.following) {
      this.applyDefault();
    }

    this.changed.fire(undefined);
    this.updateMessage();
  }

  /**
   * Refs left after the text filter.
   *
   * This is a different job from the checkboxes and worth not confusing: the filter decides what is
   * *listed here*, the checkboxes decide what is *drawn in the graph*. Narrowing the list does not
   * hide anyone's commits.
   */
  private visible(): Ref[] {
    const listed = this.listed();

    return this.tickedOnly ? listed.filter((ref) => !this.hidden.has(ref.refName)) : listed;
  }

  /**
   * Refs left after the text filter alone.
   *
   * Kept apart from `visible` because the two narrowings answer different questions, and the group
   * counts are about this one: "1 of 148" stops meaning anything the moment the 148 is itself only
   * the ticked ones.
   */
  private listed(): Ref[] {
    const needle = this.query.toLowerCase();

    const matching =
      needle.length === 0
        ? this.refs
        : this.refs.filter((ref) => ref.label.toLowerCase().includes(needle));

    if (this.order === 'name') {
      // Which is the order git listed them in: `for-each-ref` sorts by refname.
      return matching;
    }

    /*
     * A copy, because `refs` is the order they arrived in and sorting it in place would make the
     * other ordering unrecoverable without re-reading them. A ref with no date - an annotated tag,
     * whose date is the tagger's and lives in another field - sorts last rather than as 1970.
     */
    return [...matching].sort((a, b) => b.updated - a.updated);
  }

  /** Reorder the listing. The ticks, and what the graph walks, are untouched by it. */
  setOrder(order: RefOrder): void {
    if (this.order === order) {
      return;
    }

    this.order = order;
    this.publishFiltering();
    this.changed.fire(undefined);
  }

  /** Show every ref in the list again, or only the ticked ones. The graph is untouched by it. */
  setTickedOnly(only: boolean): void {
    if (this.tickedOnly === only) {
      return;
    }

    this.tickedOnly = only;
    this.publishFiltering();
    this.changed.fire(undefined);
    this.updateMessage();
  }

  /** Narrow the listing. An empty string clears it. */
  setQuery(query: string): void {
    this.query = query.trim();
    this.changed.fire(undefined);
    this.updateMessage();
    this.publishFiltering();
  }

  /**
   * Make the graph agree with the list: hide every ref the text filter does not match.
   *
   * The bridge between the two halves, and deliberately a gesture rather than a side effect of
   * typing. The box stays what it is - a way to find a ref among two hundred - and this is the one
   * click that says "and now show me only those", without the graph lurching about while a name is
   * still being typed.
   */
  showOnlyListed(): void {
    // A choice, so the default stops applying - otherwise the next reload would put it straight
    // back to the branch HEAD is on.
    this.following = false;

    const listed = new Set(this.listed().map((ref) => ref.refName));
    const before = this.hidden.size;

    this.hidden.clear();

    for (const ref of this.refs) {
      if (!listed.has(ref.refName)) {
        this.hidden.add(ref.refName);
      }
    }

    if (before === this.hidden.size && before === 0) {
      // Everything matched, so nothing changed and nothing is worth a re-walk for.
      return;
    }

    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }

  /** Whether a text filter is on, so the button that applies it can be offered only then. */
  private publishFiltering(): void {
    void vscode.commands.executeCommand('setContext', 'weft.refsListFiltered', this.query.length > 0);
    void vscode.commands.executeCommand('setContext', 'weft.refsTickedOnly', this.tickedOnly);
    void vscode.commands.executeCommand('setContext', 'weft.refsByRecent', this.order === 'recent');
  }

  get filterText(): string {
    return this.query;
  }

  /**
   * Every ref with whether it is drawn, for the header's branch menu.
   *
   * Separate from `listRefs` because that reports the group's display label, which is the right
   * thing for a picker to show and the wrong thing to branch on.
   */
  listForMenu(): {
    label: string;
    refName: string;
    kind: 'local' | 'remote' | 'tag';
    visible: boolean;
    updated: number;
  }[] {
    return this.refs.map((ref) => ({
      label: ref.label,
      refName: ref.refName,
      kind: ref.group.id === 'tags' ? 'tag' : ref.group.id === 'remotes' ? 'remote' : 'local',
      visible: !this.hidden.has(ref.refName),
      updated: ref.updated,
    }));
  }

  /**
   * Switch one ref on or off, from wherever asked.
   *
   * This is what the sidebar's own tick calls into, so the header menu and the tree cannot drift:
   * there is one hidden set, one event, and one reload.
   */
  setVisible(refNames: readonly string[], visible: boolean): void {
    let moved = false;

    for (const refName of refNames) {
      if (this.hidden.has(refName) === !visible) {
        continue;
      }

      moved = true;

      if (visible) {
        this.hidden.delete(refName);
      } else {
        this.hidden.add(refName);
      }
    }

    // Nothing changed, so nothing is announced: a group's tick set on an already-ticked group would
    // otherwise cost a full walk of the history to arrive at the same graph.
    if (!moved) {
      return;
    }

    // The set is the user's from here. Left following, the next reload would undo this tick.
    this.following = false;

    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }

  /** Every ref, for a picker to offer as completions. */
  listRefs(): { label: string; refName: string; group: string }[] {
    return this.refs.map((ref) => ({
      label: ref.label,
      refName: ref.refName,
      group: ref.group.label,
    }));
  }

  getChildren(node?: Node): Node[] {
    const refs = this.visible();

    if (node === undefined) {
      return GROUPS.filter((group) => refs.some((ref) => ref.group.id === group.id));
    }

    if (node.kind === 'group') {
      return refs.filter((ref) => ref.group.id === node.id);
    }

    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const children = this.listed().filter((ref) => ref.group.id === node.id);
      const shown = children.filter((ref) => !this.hidden.has(ref.refName)).length;

      const item = new vscode.TreeItem(
        node.label,
        this.query.length > 0 || this.tickedOnly
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `group:${node.id}`;
      item.description = shown === children.length ? `${children.length}` : `${shown}/${children.length}`;
      item.checkboxState = shown > 0 ? Checked : Unchecked;
      item.contextValue = 'weftRefGroup';
      item.tooltip = `Untick to keep every one of these out of the graph`;
      return item;
    }

    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = `ref:${node.refName}`;
    /*
     * How long since it moved, so a branch nobody has touched since March says so before you check
     * it out rather than after. HEAD keeps its badge and takes the age alongside: which branch you
     * are on and how stale it is are both worth knowing, and one is not a reason to drop the other.
     */
    const age = node.updated > 0 ? describeAge(node.updated) : '';

    item.description = node.isHead ? `HEAD${age === '' ? '' : ` · ${age}`}` : age;
    item.checkboxState = this.hidden.has(node.refName) ? Unchecked : Checked;
    /*
     * The kind is part of the context value because the menu has to tell them apart: a local branch
     * and a tag are deleted by different commands, and a remote branch is not deleted from here at
     * all - that would be a push to somebody else's clone.
     */
    item.contextValue = `weftRef${
      node.group.id === 'tags' ? 'Tag' : node.group.id === 'remotes' ? 'Remote' : 'Local'
    }`;
    item.tooltip = `${node.refName}\nUntick to keep it out of the graph`;

    item.iconPath = new vscode.ThemeIcon(
      node.group.id === 'tags' ? 'tag' : node.group.id === 'remotes' ? 'cloud' : 'git-branch',
    );

    return item;
  }

  /**
   * Wire the tree's checkboxes up.
   *
   * A group's checkbox applies to everything under it, which is the case this whole view exists
   * for: hiding two hundred remote branches one tick at a time would be worse than not having the
   * filter.
   */
  attach(view: vscode.TreeView<Node>): vscode.Disposable {
    this.view = view;
    this.updateMessage();

    return view.onDidChangeCheckboxState((event) => {
      /*
       * Through `setVisible`, and not by reaching into `hidden` directly.
       *
       * This used to do its own thing, and what it did not do was stop following HEAD - so the
       * next reload called `applyDefault` and put the tick straight back where it had been. Not
       * immediately, which is why it survived being tested: a fetch, a commit, a branch deleted or
       * the graph tab regaining focus, and the branch you ticked was gone again. The header's own
       * ticks went through `setVisible` and were fine, so the same gesture worked in one place and
       * not the other.
       *
       * One call per state rather than one per ref, because each is a reload of the graph.
       */
      const show: string[] = [];
      const hide: string[] = [];

      for (const [node, state] of event.items) {
        const targets =
          node.kind === 'group' ? this.refs.filter((ref) => ref.group.id === node.id) : [node];

        for (const ref of targets) {
          (state === Checked ? show : hide).push(ref.refName);
        }
      }

      if (show.length > 0) {
        this.setVisible(show, true);
      }

      if (hide.length > 0) {
        this.setVisible(hide, false);
      }
    });
  }

  /**
   * The line above the tree.
   *
   * A checkbox next to a branch name does not say what ticking it does, and the groups are folded
   * shut by default so there is nothing else to infer it from. While nothing is filtered the line
   * explains the gesture; once something is, it stops teaching and starts reporting - an
   * instruction that never goes away is just furniture.
   */
  private updateMessage(): void {
    if (this.view === null) {
      return;
    }

    // Empty rather than undefined: `exactOptionalPropertyTypes` rejects assigning undefined to an
    // optional property, and an empty message hides the line just the same.
    if (this.refs.length === 0) {
      this.view.message = '';
      return;
    }

    /*
     * Two independent things, said in order: what is listed here, then what reaches the graph.
     *
     * The second half is not optional. With a text filter on, the refs deciding what the graph
     * walks are the ones that are *not on screen* - filter twenty-four refs down to one and the
     * other twenty-three are still ticked, still walked, and no longer anywhere you can see or
     * reach them. A message that says only what is listed leaves the reader to conclude, quite
     * reasonably, that they are looking at the filter itself.
     */
    const total = this.refs.length;
    const listing =
      this.query.length > 0
        ? `Listing ${this.visible().length} of ${total} refs matching “${this.query}”. `
        : this.tickedOnly
          ? `Listing the ${this.visible().length} ticked of ${total}. `
          : '';

    const graph = this.following
      ? this.hidden.size === 0
        ? `HEAD is not on a branch, so the graph is walking all ${total}.`
        : 'Showing the branch you are on. Tick another to draw it as well.'
      : this.hidden.size >= total
        ? 'Nothing is ticked, so the graph is empty. Tick a branch to draw it.'
        : this.hidden.size > 0
          ? `${this.hidden.size} hidden — the graph shows the rest.`
          : this.query.length === 0
            ? 'Untick a branch or tag to keep it out of the graph.'
            : `Nothing is unticked, so the graph still walks all ${total}.`;

    this.view.message = listing + graph;
  }

  /**
   * Clear the filter and repaint, without telling the graph.
   *
   * The answer comes back rather than going out as an event because clearing everything at once
   * reloads the history once at the end, not once per view that had something to drop.
   */
  reset(): boolean {
    const before = this.hidden;
    const hadQuery = this.query.length > 0;

    // Back to the default rather than to everything: "clear filters" means "as the repository
    // opens", and this is how it opens. Show All Branches & Tags is the other button, and it is
    // the one that means everything.
    this.following = true;
    this.query = '';
    this.tickedOnly = false;
    this.applyDefault();

    const moved =
      before.size !== this.hidden.size || [...before].some((ref) => !this.hidden.has(ref));

    if (!moved && !hadQuery) {
      return false;
    }

    this.changed.fire(undefined);
    this.updateMessage();
    this.publishFiltering();

    return moved;
  }

  /**
   * The action target a tree node stands for, or null for anything that is not a ref.
   *
   * The full ref name travels with it rather than the label, for the same reason the graph's own
   * menu carries it: `main` the branch and `main` the tag are different things, and git picks one
   * of them for you if all it is given is the short name.
   */
  targetOf(node: unknown): { refName: string; label: string; refKind: 'local' | 'remote' | 'tag' } | null {
    const entry = node as Node | undefined;

    if (entry?.kind !== 'ref') {
      return null;
    }

    const refKind =
      entry.group.id === 'remotes' ? 'remote' : entry.group.id === 'tags' ? 'tag' : 'local';

    return { refName: entry.refName, label: entry.label, refKind };
  }

  /**
   * Hide every ref but this one.
   *
   * Unticking is the wrong shape for "show me only this branch": what it narrows is the set of tips
   * git walks *from*, so unticking one branch changes nothing when its commits are reachable from
   * another - which for a branch that has been merged is always. Reaching the same place by hand
   * means unticking everything else, one box at a time.
   */
  showOnly(refName: string): void {
    this.following = false;
    this.hidden.clear();

    for (const ref of this.refs) {
      if (ref.refName !== refName) {
        this.hidden.add(ref.refName);
      }
    }

    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }

  /**
   * Untick everything.
   *
   * The graph then draws nothing, which sounds useless and is where "show me these three" starts:
   * on a clone with fourteen hundred refs, ticking three is a gesture and unticking one thousand
   * four hundred and thirty-seven is not.
   */
  untickAll(): void {
    if (this.refs.length === 0 || this.hidden.size === this.refs.length) {
      return;
    }

    // A choice, and the furthest one from the default - so it stops the default applying.
    this.following = false;
    this.hidden = new Set(this.refs.map((ref) => ref.refName));

    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }

  /**
   * Back to the branch HEAD is on, and following it again.
   *
   * The same place a repository opens at, reachable without going through Clear Filters - which
   * also drops the search, the dates and the authors, and is a bigger hammer than "put the
   * branches back". The text filter is left alone: it decides what is listed, not what is drawn.
   */
  followHead(): void {
    const before = this.hidden;

    this.following = true;
    this.applyDefault();

    const moved =
      before.size !== this.hidden.size || [...before].some((ref) => !this.hidden.has(ref));

    this.changed.fire(undefined);
    this.updateMessage();

    if (moved) {
      this.filterChanged.fire();
    }
  }

  /**
   * Put everything back: both the text filter and the unticked refs.
   *
   * Both, because the button says "show all" and there is no reading of that which leaves half the
   * list hidden. They stay separate underneath - only the ticks change what the graph walks - so
   * the reload fires only when a tick actually changed. Clearing a list filter should not cost a
   * re-walk of the history.
   */
  showAll(): void {
    const hadHidden = this.hidden.size > 0;
    const hadQuery = this.query.length > 0;

    // The opposite of the default, so it has to stop following: left on, the next reload would put
    // every other ref straight back behind an unticked box.
    this.following = false;
    this.hidden.clear();
    this.query = '';
    // Listing only the ticked, with everything ticked, is a filter that hides nothing - and one
    // left switched on is one somebody has to find again later.
    this.tickedOnly = false;

    if (!hadHidden && !hadQuery) {
      return;
    }

    this.changed.fire(undefined);
    this.updateMessage();
    this.publishFiltering();

    if (hadHidden) {
      this.filterChanged.fire();
    }
  }
}

const Checked = vscode.TreeItemCheckboxState.Checked;
const Unchecked = vscode.TreeItemCheckboxState.Unchecked;
