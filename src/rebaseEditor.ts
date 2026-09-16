/**
 * The editor that opens instead of `git-rebase-todo`.
 *
 * `git rebase -i` writes a file and waits for an editor to close it. VS Code opens that file, this takes
 * it over, and what the reader gets is the list of commits rather than the text of a list of commits -
 * with the subjects and the names git left out of it.
 *
 * The document stays the truth. Every change is written into it straight away, so the file on disk and
 * the page agree at every moment, saving is saving, and somebody who would rather edit it as text can
 * reopen it that way and lose nothing.
 */

import * as vscode from 'vscode';

import type { Git } from './git/exec.ts';
import { nonce } from './panel.ts';
import type { RebaseHostMessage, RebaseRow, RebaseWebviewMessage } from './protocol.ts';
import type { TodoLine } from './git/rebaseTodo.ts';
import { describeTodo, moveCommit, parseTodo, renderTodo } from './git/rebaseTodo.ts';
import { REBASE_MARKUP } from './webview/markup.ts';

/** The line git writes at the top of the file's comments, which is the only sentence worth lifting out. */
const ONTO = /^#\s*(Rebase\s.*)$/m;

export class RebaseEditor implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'weft.rebaseTodo';

  private readonly git: Git;
  private readonly extensionUri: vscode.Uri;

  constructor(git: Git, extensionUri: vscode.Uri) {
    this.git = git;
    this.extensionUri = extensionUri;
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    panel.webview.html = html(panel.webview, this.extensionUri);

    /*
     * The file can be written from somewhere else - another editor on the same document, or this one
     * writing what the page asked for - and either way the page is drawn from what the file now says.
     */
    const changed = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document) {
        void this.send(document, panel);
      }
    });

    panel.onDidDispose(() => changed.dispose());
    panel.webview.onDidReceiveMessage((message: RebaseWebviewMessage) => void this.onMessage(message, document, panel));
  }

  private async onMessage(
    message: RebaseWebviewMessage,
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const lines = parseTodo(document.getText());

    switch (message.type) {
      case 'ready':
        await this.send(document, panel);
        break;

      case 'action':
        await this.write(document, withAction(lines, message.at, message.action));
        break;

      case 'move':
        await this.write(document, moveCommit(lines, message.at, message.by));
        break;

      /*
       * Saving and closing is what starts it: git has been waiting for the editor to exit since it
       * wrote the file, and an empty file is how it is told to stop instead.
       */
      case 'start':
        await document.save();
        panel.dispose();
        break;

      case 'abort':
        await this.write(document, []);
        await document.save();
        panel.dispose();
        break;
    }
  }

  /** The todo as it stands, with what the repository knows about each commit in it. */
  private async send(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const text = document.getText();
    const lines = parseTodo(text);
    const commits = lines.filter((line): line is Extract<TodoLine, { kind: 'commit' }> => line.kind === 'commit');
    const known = await this.describe(document, commits.map((line) => line.sha));

    const rows: RebaseRow[] = commits.map((line) => ({
      sha: line.sha,
      action: line.action,
      subject: known.get(line.sha)?.subject ?? line.rest,
      author: known.get(line.sha)?.author ?? '',
    }));

    const message: RebaseHostMessage = {
      type: 'todo',
      rows,
      summary: describeTodo(lines),
      onto: ONTO.exec(text)?.[1] ?? '',
    };

    void panel.webview.postMessage(message);
  }

  /**
   * Who wrote each commit, and what it said.
   *
   * One `git log` for the whole list rather than one for each: a rebase of forty commits would otherwise
   * be forty processes to draw one page. The file's own subjects stand in when this says nothing, so an
   * editor over a repository git cannot read is still an editor.
   */
  private async describe(
    document: vscode.TextDocument,
    shas: readonly string[],
  ): Promise<Map<string, { subject: string; author: string }>> {
    const known = new Map<string, { subject: string; author: string }>();
    const root = rootOf(document.uri.fsPath);

    if (root === null || shas.length === 0) {
      return known;
    }

    const out = await this.git
      .runRead(root, ['log', '--no-walk', '--format=%h%x00%an%x00%s', ...shas])
      .catch(() => '');

    for (const line of out.split('\n')) {
      const [sha = '', author = '', subject = ''] = line.split('\0');

      if (sha !== '') {
        known.set(sha, { subject, author });
      }
    }

    return known;
  }

  private async write(document: vscode.TextDocument, lines: readonly TodoLine[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));

    edit.replace(document.uri, whole, renderTodo(lines));
    await vscode.workspace.applyEdit(edit);
  }
}

/** The same lines with one commit's action changed, counted among the commits rather than the lines. */
function withAction(lines: readonly TodoLine[], at: number, action: RebaseRow['action']): TodoLine[] {
  let next = 0;

  return lines.map((line) => (line.kind === 'commit' && next++ === at ? { ...line, action } : line));
}

/**
 * The repository a todo file belongs to: everything above `.git`.
 *
 * Read off the path rather than asked of git, because the path is inside `.git` and asking from there
 * answers about the git directory instead. A worktree's todo lives under `.git/worktrees/<name>/`, which
 * this cuts at the same place - and git is run with `-C` on the root either way.
 */
function rootOf(path: string): string | null {
  const cut = path.replace(/\\/g, '/').lastIndexOf('/.git/');

  return cut < 0 ? null : path.slice(0, cut);
}

/** The page: the graph's content security policy, with a script and a stylesheet from `dist`. */
function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'rebase.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'style.css'));
  const n = nonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${n}'; connect-src 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style.toString()}" rel="stylesheet">
<title>Interactive rebase</title>
</head>
<body class="weft-rebase">
${REBASE_MARKUP}
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
}
