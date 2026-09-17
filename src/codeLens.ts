/**
 * One line above a file: who last changed it, and how long ago.
 *
 * The question a file raises before any line of it does - is this current, and whose is it - answered
 * where the file is rather than in a graph somewhere else. Clicking it narrows the graph to that file,
 * which is the next question.
 *
 * One `git log -1` a file, and kept until something could change the answer: editing the file cannot,
 * so typing costs nothing, while a commit, a checkout or a fetch in *that* repository drops what is
 * held and VS Code asks again. `weft.codeLens` turns it off for anybody who wants their first line
 * back.
 *
 * `-1` bounds the output and not the walk, so the worst case is git comparing trees all the way back
 * to the root commit. Measured on a 78,597-commit repository: 285 ms for a file changed last week,
 * 274 ms for a path that never existed at all, which is that worst case. Both are a background read
 * off the UI thread, so the walk is left unbounded rather than paid for with a lens that can only
 * speak about recent history.
 */

import * as vscode from 'vscode';
import { dirname } from 'node:path';

import type { RepoInfo } from './git/discovery.ts';
import { discover } from './git/discovery.ts';
import type { Git } from './git/exec.ts';
import { describeLastChange, parseLastChange } from './git/lastChange.ts';
import { canonical, watchRepositoryChanges } from './git/vscodeGit.ts';

export class FileCodeLens implements vscode.CodeLensProvider {
  private readonly git: Git;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly repos = new Map<string, Promise<RepoInfo | null>>();
  private readonly known = new Map<string, { readonly root: string; readonly lenses: vscode.CodeLens[] }>();
  private readonly disposables: vscode.Disposable[] = [];

  /** VS Code asks again when this fires: a commit or a checkout, or the setting being turned back on. */
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(git: Git) {
    this.git = git;
    this.disposables.push(
      this.changed,
      watchRepositoryChanges((root) => this.refresh(root)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('weft.codeLens')) {
          this.refresh(null);
        }
      }),
      // A file nobody has open has no line above it, and holding its answer is holding it for nothing.
      vscode.workspace.onDidCloseTextDocument((document) => this.known.delete(document.uri.fsPath)),
    );
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const on = vscode.workspace.getConfiguration('weft').get<boolean>('codeLens', true);

    if (!on || document.uri.scheme !== 'file') {
      return [];
    }

    const path = document.uri.fsPath;
    const held = this.known.get(path);

    if (held !== undefined) {
      return held.lenses;
    }

    const repo = await this.repoOf(path);

    if (repo === null) {
      return [];
    }

    const out = await this.git
      .runRead(repo.root, ['log', '-1', '--format=%H%x00%aN%x00%aI', '--', path])
      .catch(() => '');
    const change = parseLastChange(out);

    if (change === null) {
      return [];
    }

    const top = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const lenses = [
      new vscode.CodeLens(top, {
        title: describeLastChange(change),
        tooltip: 'Show this file in the graph',
        command: 'weft.showFileHistory',
        arguments: [document.uri],
      }),
    ];

    this.known.set(path, { root: canonical(repo.root), lenses });
    return lenses;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Which repository a file is in, asked once per directory: every file in one folder shares it. */
  private repoOf(path: string): Promise<RepoInfo | null> {
    const dir = dirname(path);
    const known = this.repos.get(dir);

    if (known !== undefined) {
      return known;
    }

    const asked = discover(this.git, dir).catch(() => null);

    this.repos.set(dir, asked);

    /*
     * A repository found stays found - they do not move - but "no repository here" is an answer with a
     * shelf life: `git init` in a folder somebody already has open would otherwise leave every file in
     * it without a line for the rest of the session.
     */
    void asked.then((repo) => {
      if (repo === null) {
        this.repos.delete(dir);
      }
    });

    return asked;
  }

  /**
   * Drop what was read for one repository, or for all of them when there is no saying which.
   *
   * VS Code asks again for every visible editor when this fires, and each ask is a walk of a history.
   * Clearing everything for a commit in one repository charged that walk to every other one open.
   */
  private refresh(root: string | null): void {
    const moved = root === null ? null : canonical(root);

    for (const [path, held] of [...this.known]) {
      if (moved === null || held.root === moved) {
        this.known.delete(path);
      }
    }

    this.changed.fire();
  }
}
