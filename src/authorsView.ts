/**
 * The Authors sidebar: whose commits the graph should draw.
 *
 * The search box has had an `author` mode all along, but typing a name from memory is a poor way
 * to use a filter - you have to already know who is in the history and how they spell themselves.
 * A list you tick is the same filter without the recall problem.
 *
 * Like the ref filter, this narrows what `git log` walks rather than hiding rows after the fact.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import type { Author } from './git/authors.ts';
import { authorArgs, listAuthors } from './git/authors.ts';

/** What the list is sorted by. */
export type AuthorOrder = 'commits' | 'name';

export class AuthorsProvider implements vscode.TreeDataProvider<Author> {
  private readonly git: Git;
  private readonly changed = new vscode.EventEmitter<Author | undefined>();
  private readonly filterChanged = new vscode.EventEmitter<void>();

  private repo: RepoInfo | null = null;
  private authors: Author[] = [];
  private loaded = false;
  private view: vscode.TreeView<Author> | null = null;

  /** Selected authors, by name. Empty means everyone, which is not the same as nobody. */
  private selected = new Set<string>();

  /** Ticked authors per repository, for the same two reasons the ref view keeps its own. */
  private readonly selectedByRepo = new Map<string, Set<string>>();

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

  constructor(git: Git) {
    this.git = git;
  }

  setRepository(repo: RepoInfo | null): void {
    if (repo?.root === this.repo?.root) {
      return;
    }

    if (this.repo !== null) {
      this.selectedByRepo.set(this.repo.root, this.selected);
    }

    this.repo = repo;
    this.authors = [];
    this.loaded = false;
    this.selected = this.selectedByRepo.get(repo?.root ?? '') ?? new Set<string>();
    // A name typed to find someone in one repository means nothing in another.
    this.query = '';
    this.publishFiltering();
    this.changed.fire(undefined);
  }

  /**
   * `git log` arguments for the current selection; empty when nobody is filtered out.
   *
   * Answered for one repository only - the one this view is showing. Every open graph reloads when
   * a tick moves, and a name that authored nothing in the other one filters it down to nothing.
   */
  filterArgs(root: string): string[] {
    if (this.repo === null || this.repo.root !== root || this.selected.size === 0) {
      return [];
    }

    /*
     * Every spelling of every ticked name, not only the one the row happened to show.
     *
     * A row can be the fold of `Max_Chiue` and `max_chiue`, and `--author` is case-sensitive, so
     * passing one of them walks a fraction of what the row counted. git takes multiple `--author`
     * as "any of these", which makes naming them all exact - and exact is worth more here than
     * `-i`, which is a walk-wide flag and would quietly widen the user's own search with it.
     */
    const spellings = [...this.selected].flatMap(
      (name) => this.authors.find((author) => author.name === name)?.names ?? [name],
    );

    return authorArgs(spellings);
  }

  /**
   * Loaded when the section is first expanded, not when the panel opens.
   *
   * `shortlog` walks the entire history; on a large repository that is seconds of work for a list
   * nobody has asked to see yet.
   */
  async getChildren(node?: Author): Promise<Author[]> {
    if (node !== undefined || this.repo === null) {
      return [];
    }

    if (!this.loaded) {
      this.authors = await listAuthors(this.git, this.repo);
      this.loaded = true;
      this.updateMessage();
    }

    return this.visible();
  }

  /** Authors left after the text filter, in the chosen order. Addresses match as well as names. */
  private visible(): Author[] {
    const needle = this.query.toLowerCase();

    const listed =
      needle.length === 0
        ? this.authors
        : this.authors.filter(
            (author) =>
              author.names.some((name) => name.toLowerCase().includes(needle)) ||
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

    const before = this.selected.size;

    this.selected.clear();

    for (const author of listed) {
      this.selected.add(author.name);
    }

    // Nothing moved, so nothing is announced: re-applying the same set would cost a full walk of
    // the history to arrive at the same graph.
    if (before === this.selected.size && before === listed.length) {
      this.changed.fire(undefined);
      this.updateMessage();
      return;
    }

    this.changed.fire(undefined);
    this.updateMessage();
    this.filterChanged.fire();
  }

  private publishFiltering(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'weft.authorsListFiltered',
      this.query.length > 0,
    );
  }

  getTreeItem(author: Author): vscode.TreeItem {
    // Every spelling on the row, busiest first. One person's row saying `Sean Lin, sean_lin` is
    // how the reader knows the count in front of them covers both, rather than wondering where the
    // other one went.
    const item = new vscode.TreeItem(author.names.join(', '), vscode.TreeItemCollapsibleState.None);

    // Unique now that the rows are one per person. It was not while two addresses could share a
    // name, and a tree with two items claiming the same id draws one of them twice.
    item.id = `author:${author.name.toLowerCase()}`;

    /*
     * What the row is made of, on the row rather than only in the tooltip: a name that turns out
     * to be two addresses and two spellings is the answer to "why is that number bigger than I
     * expected", and it is not a question anybody thinks to hover over.
     */
    item.description =
      author.emails.length > 1
        ? `${author.commits} · ${author.emails.length} emails`
        : `${author.commits}`;

    item.tooltip = [
      ...author.names,
      ...author.emails.map((email) => `<${email}>`),
      `${author.commits} commits, across the whole history - the count takes no notice of what the graph is filtered to`,
      'Tick to show only these',
    ].join('\n');
    // Ticked means "only these", the opposite polarity to the ref filter. With nobody ticked
    // everyone is shown and no box is ticked - starting all-ticked would suggest that unticking one
    // hides that person, which is not what happens.
    item.checkboxState = this.selected.has(author.name)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    item.iconPath = new vscode.ThemeIcon('account');
    return item;
  }

  attach(view: vscode.TreeView<Author>): vscode.Disposable {
    this.view = view;
    this.publishOrder();
    this.updateMessage();

    return view.onDidChangeCheckboxState((event) => {
      for (const [author, state] of event.items) {
        if (state === vscode.TreeItemCheckboxState.Checked) {
          this.selected.add(author.name);
        } else {
          this.selected.delete(author.name);
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
          : `${this.selected.size} ticked, which is what the graph is showing.`;

      this.view.message = `Listing ${listed} of ${total} authors matching \u201C${this.query}\u201D. ${ticked}`;
      return;
    }

    this.view.message =
      this.selected.size === 0
        ? 'Tick an author to show only their commits. The counts are for the whole history.'
        : `Showing ${this.selected.size} of ${total} authors.`;
  }
}
