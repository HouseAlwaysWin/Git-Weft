/**
 * The Line History section: the commits that touched the lines you asked about.
 *
 * A list of its own rather than the graph narrowed down, and that is forced rather than chosen.
 * `git log -L` walks from exactly one commit - see `git/lineHistory.ts` - so it cannot be the
 * graph's walk with a filter on it, and taking the graph over would have meant standing the branch
 * ticks down every time somebody asked about three lines and handing them back afterwards. A filter
 * set somebody spent effort on should not be dismantled by a question that has nothing to do with
 * it. Side by side, the graph keeps answering what it was answering.
 *
 * Absent until asked for, because a section that is empty most of the time is a section people
 * learn to skip past.
 */

import * as vscode from 'vscode';

import type { Commit } from './git/logParser.ts';
import type { LineRange } from './git/lineHistory.ts';
import { describeAge } from './git/blame.ts';

/** What the section is currently answering about. */
interface Question {
  readonly root: string;
  readonly range: LineRange;
}

export class LineHistoryProvider implements vscode.TreeDataProvider<Commit> {
  private readonly changed = new vscode.EventEmitter<void>();

  private view: vscode.TreeView<Commit> | null = null;
  private asked: Question | null = null;
  private commits: Commit[] = [];

  readonly onDidChangeTreeData = this.changed.event;

  attach(view: vscode.TreeView<Commit>): void {
    this.view = view;
    this.updateHeading();
  }

  /** Point the section at a range, and open it. */
  show(root: string, range: LineRange, commits: readonly Commit[]): void {
    this.asked = { root, range };
    this.commits = [...commits];
    this.publish();
  }

  /** Put it away. The question has been answered, or the file it was about is gone. */
  clear(): void {
    this.asked = null;
    this.commits = [];
    this.publish();
  }

  private publish(): void {
    void vscode.commands.executeCommand('setContext', 'weft.lineHistory', this.asked !== null);
    this.changed.fire();
    this.updateHeading();
  }

  getChildren(node?: Commit): Commit[] {
    // One level: a commit that touched the lines is the whole answer, and what it changed is a
    // question the graph and Commit Files already answer better.
    return node === undefined ? this.commits : [];
  }

  getTreeItem(commit: Commit): vscode.TreeItem {
    const item = new vscode.TreeItem(commit.subject, vscode.TreeItemCollapsibleState.None);
    const when = Date.parse(commit.authorDate);

    item.id = `line:${commit.sha}`;
    item.description = `${commit.author} · ${Number.isNaN(when) ? '' : describeAge(when)}`;

    item.tooltip = new vscode.MarkdownString(
      [
        commit.subject,
        '',
        `${commit.author} <${commit.email}>`,
        commit.authorDate,
        `\`${commit.sha.slice(0, 12)}\``,
        '',
        'Click to find it in the graph.',
      ].join('\n\n'),
    );

    item.iconPath = new vscode.ThemeIcon('git-commit');

    /*
     * The same command the blame hover uses, so a commit found from a line lands in the graph the
     * one way rather than two - and so this list can point at the graph without owning it.
     */
    item.command = {
      command: 'weft.revealCommit',
      title: 'Show in Graph',
      arguments: [{ sha: commit.sha, root: this.asked?.root }],
    };

    return item;
  }

  /**
   * What the section is about, above the list.
   *
   * The lines are the whole of the question, so they go in the heading rather than being left for
   * somebody to remember. And it says HEAD out loud: "the history of these lines" has a different
   * answer on a different branch, and this one cannot be asked from anywhere else.
   */
  private updateHeading(): void {
    if (this.view === null) {
      return;
    }

    const asked = this.asked;

    if (asked === null) {
      this.view.description = '';
      this.view.message = 'Select some lines in a file and choose Show Line History.';
      return;
    }

    const { path, from, to } = asked.range;
    const name = path.split('/').pop() ?? path;
    const lines = from === to ? `line ${from}` : `lines ${from}-${to}`;

    this.view.description = `${name} · ${lines}`;

    this.view.message =
      this.commits.length > 0
        ? ''
        : `No commit has touched ${lines} of ${name}, back from where HEAD is now.`;
  }
}
