/**
 * One line above a file: who last changed it, and how long ago.
 *
 * The question a file raises before any line of it does - is this current, and whose is it - answered
 * where the file is rather than in a graph somewhere else. Clicking it narrows the graph to that file,
 * which is the next question.
 *
 * One `git log -1` a file, and kept until something could change the answer: editing the file cannot,
 * so typing costs nothing, while a commit, a checkout or a fetch drops what is held and VS Code asks
 * again. `weft.codeLens` turns it off for anybody who wants their first line back.
 */

import * as vscode from 'vscode';
import { dirname } from 'node:path';

import type { RepoInfo } from './git/discovery.ts';
import { discover } from './git/discovery.ts';
import type { Git } from './git/exec.ts';
import { describeLastChange, parseLastChange } from './git/lastChange.ts';
import { watchRepositoryChanges } from './git/vscodeGit.ts';

export class FileCodeLens implements vscode.CodeLensProvider {
  private readonly git: Git;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly repos = new Map<string, Promise<RepoInfo | null>>();
  private readonly known = new Map<string, vscode.CodeLens[]>();
  private readonly disposables: vscode.Disposable[] = [];

  /** VS Code asks again when this fires: a commit or a checkout, or the setting being turned back on. */
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(git: Git) {
    this.git = git;
    this.disposables.push(
      this.changed,
      watchRepositoryChanges(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('weft.codeLens')) {
          this.refresh();
        }
      }),
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
      return held;
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

    this.known.set(path, lenses);
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
    return asked;
  }

  private refresh(): void {
    this.known.clear();
    this.changed.fire();
  }
}
