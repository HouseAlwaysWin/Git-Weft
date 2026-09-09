/**
 * The Authors sidebar: whose commits the graph should draw.
 *
 * The search box has had an `author` mode all along, but typing a name from memory is a poor way
 * to use a filter - you have to already know who is in the history and how they spell themselves.
 * A list you tick is the same filter without the recall problem.
 *
 * Like the ref filter, this narrows what `git log` walks rather than hiding rows after the fact.
 *
 * **Two levels.** One person is often several spellings, and the row used to be all of them joined
 * by commas - which is a list pretending to be a name, and unreadable by four of them. A person is
 * a group you can open, its spellings are the rows inside, and a name that matched nobody else is
 * a plain row rather than a group of one. Where the spelling rule cannot tell - `Lineric` and
 * `lineric_lin` share a prefix and nothing that can be proved - the answer is a group made by hand,
 * and those are remembered per repository.
 *
 * **A group is a label, not a box.** Somebody is on the platform team and on the release rota, and
 * being made to choose one of those is being asked the wrong question - so a spelling can be put in
 * as many groups as it belongs to, and is listed under each. What it stops being is listed under
 * the rule's answer: an assignment replaces that rather than adding to it, or the first person you
 * grouped would appear twice.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import type { Author, AuthorIdentity } from './git/authors.ts';
import { fingerprint, groupAuthors, listAuthors, readGroupAssignments } from './git/authors.ts';
import type { AuthorPick } from './git/search.ts';

/** What the list is sorted by. */
export type AuthorOrder = 'commits' | 'name';

/** A person: one spelling, or several gathered under one name. */
interface GroupNode {
  readonly kind: 'group';
  readonly author: Author;
}

/** One spelling inside a person. Only ever a child, and only when there is more than one. */
interface MemberNode {
  readonly kind: 'member';
  readonly identity: AuthorIdentity;
  /**
   * The group it is being shown under, or null when the rule put it there.
   *
   * Carried on the node because the same spelling can be shown under several groups, and "take
   * this one out" has to mean out of the one that was right-clicked rather than out of all of them.
   */
  readonly group: string | null;
}

export type AuthorNode = GroupNode | MemberNode;

/** Where hand-made groups live, keyed by repository so one clone's answer is not another's. */
const GROUPS_KEY = 'weft.authorGroups';

export class AuthorsProvider implements vscode.TreeDataProvider<AuthorNode> {
  private readonly git: Git;
  private readonly memento: vscode.Memento;
  private readonly changed = new vscode.EventEmitter<AuthorNode | undefined>();
  private readonly filterChanged = new vscode.EventEmitter<void>();

  private repo: RepoInfo | null = null;
  /** Every spelling git knows, before any judgement about which are the same person. */
  private identities: AuthorIdentity[] = [];
  private authors: Author[] = [];
  private loaded = false;
  private view: vscode.TreeView<AuthorNode> | null = null;

  /**
   * Ticked spellings, exactly as git records them.
   *
   * By spelling and not by group, because a spelling is what `--author` takes and because the two
   * levels can be ticked separately: a group's box is every one of its spellings at once, and one
   * spelling on its own is a perfectly reasonable thing to want.
   */
  private selected = new Set<string>();

  /** Ticked spellings per repository, for the same two reasons the ref view keeps its own. */
  private readonly selectedByRepo = new Map<string, Set<string>>();

  /** Spelling to the groups it was put in by hand, in the order they were added. */
  private custom = new Map<string, string[]>();

  /**
   * Text narrowing the *listing*, which is a different job from the ticks.
   *
   * The ticks decide whose commits the graph walks. This decides who is on screen to tick. On a
   * repository with two hundred contributors the second is what stands between you and the first.
   */
  private query = '';

  /**
   * How the list is ordered.
   *
   * By commits to begin with: "who works on this" is the question a list of authors is usually
   * being asked, and the busiest names are the ones worth ticking. By name is for when you already
   * know who you are looking for and the list is long enough to lose them in.
   */
  private order: AuthorOrder = 'commits';

  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChangeFilter = this.filterChanged.event;

  constructor(git: Git, memento: vscode.Memento) {
    this.git = git;
    this.memento = memento;
  }

  setRepository(repo: RepoInfo | null): void {
    if (repo?.root === this.repo?.root) {
      return;
    }

    if (this.repo !== null) {
      this.selectedByRepo.set(this.repo.root, this.selected);
    }

    this.repo = repo;
    this.identities = [];
    this.authors = [];
    this.loaded = false;
    this.selected = this.selectedByRepo.get(repo?.root ?? '') ?? new Set<string>();
    this.custom = this.readGroups();
    // A name typed to find someone in one repository means nothing in another.
    this.query = '';
    this.publishFiltering();
    this.changed.fire(undefined);
  }

  /**
   * Who the graph should walk; empty when nobody is filtered out.
   *
   * Answered for one repository only - the one this view is showing. Every open graph reloads when
   * a tick moves, and a name that authored nothing in the other one filters it down to nothing.
   *
   * Spellings exactly as ticked, and people rather than `--author` arguments: the search box has an
   * author mode of its own, git reads several `--author` as "any of these", and two filters that
   * widen each other are not two filters. Whoever writes the command line has to see both halves at
   * once, so this hands over the people and lets `filterArgs` decide what to say about them.
   *
   * The addresses come too, because `--author` matches `Name <email>` and a query may be either.
   */
  authorPicks(root: string): AuthorPick[] {
    if (this.repo === null || this.repo.root !== root || this.selected.size === 0) {
      return [];
    }

    const known = new Map(this.identities.map((identity) => [identity.name, identity]));

    // A spelling with no identity behind it was ticked before the list loaded: still a name git can
    // be asked about, just without the addresses.
    return [...this.selected].map((name) => ({ name, emails: known.get(name)?.emails ?? [] }));
  }

  /**
   * Loaded when the section is first expanded, not when the panel opens.
   *
   * `shortlog` walks the entire history; on a large repository that is seconds of work for a list
   * nobody has asked to see yet.
   */
  async getChildren(node?: AuthorNode): Promise<AuthorNode[]> {
    if (this.repo === null) {
      return [];
    }

    if (node === undefined) {
      if (!this.loaded) {
        this.identities = await listAuthors(this.git, this.repo);
        this.regroup();
        this.loaded = true;
        this.updateMessage();
      }

      return this.visible().map((author) => ({ kind: 'group', author }));
    }

    // A person of one spelling is not something to open: the row already says everything.
    return node.kind === 'group' && node.author.members.length > 1
      ? node.author.members.map((identity) => ({
          kind: 'member' as const,
          identity,
          group: node.author.custom ? node.author.name : null,
        }))
      : [];
  }

  /** Authors left after the text filter, in the chosen order. Spellings and addresses both match. */
  private visible(): Author[] {
    const needle = this.query.toLowerCase();

    const listed =
      needle.length === 0
        ? this.authors
        : this.authors.filter(
            (author) =>
              author.name.toLowerCase().includes(needle) ||
              author.members.some((member) => member.name.toLowerCase().includes(needle)) ||
              author.emails.some((email) => email.toLowerCase().includes(needle)),
          );

    // A copy. `authors` is the order the history came back in, and sorting it in place would make
    // that order unrecoverable without walking the history again.
    return this.order === 'name'
      ? [...listed].sort((a, b) => a.name.localeCompare(b.name))
      : listed;
  }

  /** Reorder the listing. The ticks and what the graph walks are untouched by it. */
  setOrder(order: AuthorOrder): void {
    if (this.order === order) {
      return;
    }

    this.order = order;
    this.publishOrder();
    this.changed.fire(undefined);
    this.updateMessage();
  }

  private publishOrder(): void {
    void vscode.commands.executeCommand('setContext', 'weft.authorsByName', this.order === 'name');
  }

  /** Narrow the listing. An empty string clears it. */
  setQuery(query: string): void {
    this.query = query.trim();
    this.changed.fire(undefined);
    this.updateMessage();
    this.publishFiltering();
  }

  get filterText(): string {
    return this.query;
  }

  /** Every author, for a picker to offer as completions. */
  listAuthors(): { name: string; emails: readonly string[]; commits: number }[] {
    return this.visible().map((author) => ({
      name: author.name,
      emails: author.emails,
      commits: author.commits,
    }));
  }

  /** The names groups already have, so a picker can offer joining one rather than inventing one. */
  groupNames(): string[] {
    return this.authors.filter((author) => author.members.length > 1 || author.custom).map((author) => author.name);
  }

  /** The groups a node is already in, so a picker does not offer somewhere it already is. */
  groupsOf(node: AuthorNode): string[] {
    const names = new Set<string>();

    for (const spelling of this.spellingsOf(node)) {
      // Through the same fallback `addToGroup` uses, so the picker does not offer somewhere the
      // spelling already is on the strength of nobody having written it down yet.
      for (const group of this.custom.get(spelling) ?? this.heldBy(spelling)) {
        names.add(group);
      }
    }

    return [...names];
  }

  /** Which group a right-click was in: a spelling's own row, or the group row itself. */
  groupAt(node: AuthorNode): string | null {
    return node.kind === 'member' ? node.group : node.author.custom ? node.author.name : null;
  }

  /** The spellings a node stands for: one, or all of a group's. */
  spellingsOf(node: AuthorNode): string[] {
    return node.kind === 'member'
      ? [node.identity.name]
      : node.author.members.map((member) => member.name);
  }

  /** What a node is called, for a dialog to name what it is about to move. */
  labelOf(node: AuthorNode): string {
    return node.kind === 'member' ? node.identity.name : node.author.name;
  }

/**
   * Put these spellings in a group, keeping whatever groups they are already in.
   *
   * Adding rather than replacing is the whole of the difference: the same person is on more than
   * one team, and a list that makes them choose is not describing the place they work.
   */
  addToGroup(spellings: readonly string[], group: string): void {
    const key = fingerprint(group);

    for (const spelling of spellings) {
      const already = this.custom.get(spelling) ?? [];
      const from = already.length > 0 ? already : this.heldBy(spelling);

      // By fingerprint, because `Backend` and `backend` are one group everywhere else here.
      if (!from.some((name) => fingerprint(name) === key)) {
        this.custom.set(spelling, [...from, group]);
      } else if (from !== already) {
        this.custom.set(spelling, from);
      }
    }

    this.saveGroups();
  }

  /**
   * The hand-made group a spelling is in without being named in it, if any.
   *
   * Group `lineric_lin` with `Lineric` and only one of the two is written down: the other is in that
   * group because the group was named after it, which is the ordinary way to make one. Adding a
   * label to the pair then wrote down the unnamed one for the first time - and writing down where
   * it is going without writing down where it was would have taken it out of the group its own name
   * had made, splitting the person somebody had just finished joining together.
   *
   * Only for hand-made groups. Being in the rule's own fold is exactly what an assignment replaces,
   * so putting a person on a team takes their unlabelled row away, which is what it should do.
   */
  private heldBy(spelling: string): string[] {
    const row = this.authors.find((author) =>
      author.members.some((member) => member.name === spelling),
    );

    return row !== undefined && row.custom ? [row.name] : [];
  }

  /**
   * Take these spellings out of one group, or out of every group when no group is named.
   *
   * Out of the last one is not the same as alone: with no assignments left the spelling goes back
   * to the rule that folds by case and separators, which may well put it straight back with the
   * same people. That is the right answer - a group is an override, and removing one restores what
   * was underneath rather than inventing a third state.
   */
  removeFromGroup(spellings: readonly string[], group: string | null): void {
    const key = group === null ? null : fingerprint(group);

    for (const spelling of spellings) {
      const left =
        key === null
          ? []
          : (this.custom.get(spelling) ?? []).filter((name) => fingerprint(name) !== key);

      if (left.length === 0) {
        this.custom.delete(spelling);
      } else {
        this.custom.set(spelling, left);
      }
    }

    this.saveGroups();
  }

  private saveGroups(): void {
    this.writeGroups();
    this.regroup();
    this.changed.fire(undefined);
    this.updateMessage();
  }

  private regroup(): void {
    this.authors = groupAuthors(this.identities, this.custom);
  }

  private readGroups(): Map<string, string[]> {
    const stored = this.memento.get<Record<string, Record<string, string | string[]>>>(
      GROUPS_KEY,
      {},
    );

    return readGroupAssignments(stored[this.repo?.root ?? ''] ?? {});
  }

  private writeGroups(): void {
    if (this.repo === null) {
      return;
    }

    const stored = {
      ...this.memento.get<Record<string, Record<string, string | string[]>>>(GROUPS_KEY, {}),
    };

    stored[this.repo.root] = Object.fromEntries(this.custom);
    void this.memento.update(GROUPS_KEY, stored);
  }

  /**
   * Tick everyone the list is currently showing.
   *
   * The gesture the text filter exists to enable: narrow to a team, a surname, a company's domain,
   * then show the graph exactly those people. Doing it a tick at a time is the thing that made a
   * long list unusable in the first place.
   */
  showOnlyListed(): void {
    const listed = this.visible();

    if (listed.length === 0) {
      return;
    }

    const before = [...this.selected].sort().join('\n');

    this.selected.clear();

    for (const author of listed) {
      for (const member of author.members) {
        this.selected.add(member.name);
      }
    }

    this.changed.fire(undefined);
    this.updateMessage();

    // Nothing moved, so nothing is announced: re-applying the same set would cost a full walk of
    // the history to arrive at the same graph.
    if (before !== [...this.selected].sort().join('\n')) {
      this.filterChanged.fire();
    }
  }

  private publishFiltering(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'weft.authorsListFiltered',
      this.query.length > 0,
    );
  }

  getTreeItem(node: AuthorNode): vscode.TreeItem {
    return node.kind === 'member'
      ? this.memberItem(node.identity, node.group)
      : this.groupItem(node.author);
  }

  private groupItem(author: Author): vscode.TreeItem {
    const several = author.members.length > 1;

    const item = new vscode.TreeItem(
      author.name,
      several ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );

    item.id = `author:${author.name.toLowerCase()}`;

    /*
     * What the row is made of, on the row rather than only in the tooltip: a name that turns out to
     * be three spellings is the answer to "why is that number bigger than I expected", and it is
     * not a question anybody thinks to hover over.
     */
    const ticked = author.members.filter((member) => this.selected.has(member.name)).length;

    item.description = [
      `${author.commits}`,
      ...(several ? [`${author.members.length} spellings`] : []),
      ...(author.emails.length > 1 ? [`${author.emails.length} emails`] : []),
      // Only while it is neither all nor nothing, which the box itself cannot show.
      ...(ticked > 0 && ticked < author.members.length ? [`${ticked} ticked`] : []),
    ].join(' · ');

    /*
     * A person in two groups is counted by both of them, so the rows can add up to more than the
     * history has. Said on the row it applies to rather than left for somebody to work out from
     * two numbers that do not reconcile.
     */
    const shared = author.members.filter((member) => (this.custom.get(member.name) ?? []).length > 1);

    item.tooltip = [
      ...author.members.map((member) => `${member.name} — ${member.commits}`),
      ...author.emails.map((email) => `<${email}>`),
      `${author.commits} commits, across the whole history - the count takes no notice of what the graph is filtered to`,
      author.custom ? 'Grouped by hand' : 'Grouped by spelling',
      ...(shared.length > 0
        ? [`${shared.length} of these are in other groups too, which count them as well`]
        : []),
      'Tick to show only these',
    ].join('\n');

    /*
     * Ticked means "only these", the opposite polarity to the ref filter. With nobody ticked
     * everyone is shown and no box is ticked - starting all-ticked would suggest that unticking one
     * hides that person, which is not what happens.
     *
     * A group is ticked when all of it is. Half a group ticked reads as unticked, and says so in
     * the description, because there is no third box state to say it with.
     */
    item.checkboxState =
      ticked === author.members.length && ticked > 0
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;

    item.contextValue = author.custom ? 'weftAuthorGroupCustom' : 'weftAuthorGroup';
    item.iconPath = new vscode.ThemeIcon('account');
    return item;
  }

  private memberItem(identity: AuthorIdentity, group: string | null): vscode.TreeItem {
    const item = new vscode.TreeItem(identity.name, vscode.TreeItemCollapsibleState.None);

    // The group is in the id because the same spelling appears under every group it is in, and two
    // rows sharing an id is one row as far as the tree is concerned.
    item.id = `spelling:${group ?? ''}:${identity.name}`;

    const elsewhere = (this.custom.get(identity.name) ?? []).filter(
      (name) => group === null || fingerprint(name) !== fingerprint(group),
    );

    item.description = [
      `${identity.commits}`,
      ...(identity.emails.length > 1 ? [`${identity.emails.length} emails`] : []),
      // Where else this same person is listed, on the row, because the tree cannot show it twice
      // at once and a count that appears in two places should say that it does.
      ...(elsewhere.length > 0 ? [`also in ${elsewhere.join(', ')}`] : []),
    ].join(' · ');

    item.tooltip = [
      identity.name,
      ...identity.emails.map((email) => `<${email}>`),
      `${identity.commits} commits under this spelling`,
      ...(elsewhere.length > 0 ? [`Also in ${elsewhere.join(', ')}`] : []),
    ].join('\n');

    item.checkboxState = this.selected.has(identity.name)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    item.contextValue = group === null ? 'weftAuthorSpelling' : 'weftAuthorSpellingCustom';
    item.iconPath = new vscode.ThemeIcon('mention');
    return item;
  }

  attach(view: vscode.TreeView<AuthorNode>): vscode.Disposable {
    this.view = view;
    this.publishOrder();
    this.updateMessage();

    return view.onDidChangeCheckboxState((event) => {
      for (const [node, state] of event.items) {
        // A group's box is every spelling in it: the group is the person, and half a person is not
        // what anybody meant by ticking them.
        for (const spelling of this.spellingsOf(node)) {
          if (state === vscode.TreeItemCheckboxState.Checked) {
            this.selected.add(spelling);
          } else {
            this.selected.delete(spelling);
          }
        }
      }

      this.changed.fire(undefined);
      this.updateMessage();
      this.filterChanged.fire();
    });
  }

  /** Clear the selection and repaint. Announcing it is the caller's, so a bulk clear reloads once. */
  reset(): boolean {
    const filtered = this.query.length > 0;

    if (this.selected.size === 0 && !filtered) {
      return false;
    }

    const wasSelecting = this.selected.size > 0;

    this.selected.clear();
    this.query = '';
    this.publishFiltering();
    this.changed.fire(undefined);
    this.updateMessage();

    // Clearing a listing filter changes nothing the graph walked, so it is not worth a reload. Only
    // the ticks were.
    return wasSelecting;
  }

  showAll(): void {
    if (this.reset()) {
      this.filterChanged.fire();
    }
  }

  private updateMessage(): void {
    if (this.view === null) {
      return;
    }

    /*
     * The query, in the section header beside the word "Authors".
     *
     * A tree view cannot hold a text box, so the filter is typed into a picker that closes behind
     * itself - and a filter you cannot see is one you forget is on, which makes the list look like
     * it has lost people. The header is the one part of a collapsed section that stays visible.
     */
    this.view.description = this.query.length > 0 ? `“${this.query}”` : '';

    if (!this.loaded) {
      this.view.message = '';
      return;
    }

    const listed = this.visible().length;
    const total = this.authors.length;

    /*
     * The message has to carry the half that is not on screen.
     *
     * Narrowing the list leaves everyone who fell out of it exactly as they were - the graph is
     * unchanged by typing a name. A line naming only what is listed invites the reader to conclude
     * they are looking at the filter itself, which is the same trap the ref list had.
     */
    if (this.query.length > 0) {
      const ticked =
        this.selected.size === 0
          ? 'Nothing is ticked, so the graph still shows everyone.'
          : `${this.selected.size} spellings ticked, which is what the graph is showing.`;

      this.view.message = `Listing ${listed} of ${total} authors matching “${this.query}”. ${ticked}`;
      return;
    }

    this.view.message =
      this.selected.size === 0
        ? 'Tick an author to show only their commits. The counts are for the whole history.'
        : `${this.selected.size} spellings ticked, of ${total} authors.`;
  }
}
