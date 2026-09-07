/**
 * Who last changed the line the cursor is on, at the end of that line.
 *
 * One line rather than all of them. Annotating every line turns a file into two columns and the
 * code into the narrower one; annotating the line being read answers the question that actually
 * comes up - "why is this here" - without changing what the file looks like to work in.
 *
 * The cost worth watching is process spawns. A cursor moving down a file would otherwise be one
 * `git blame` per keystroke, so this blames the whole file once, keys the answer on the document's
 * version, and only asks again when the text has actually changed. Moving about inside an
 * unchanged file spawns nothing.
 */

import * as vscode from 'vscode';
import { dirname } from 'node:path';

import type { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { discover } from './git/discovery.ts';
import type { Blame, BlameLine } from './git/blame.ts';
import { blameFile, describeAge } from './git/blame.ts';

/** Long enough that a held arrow key is one blame rather than forty, short enough not to lag. */
const SETTLE_MS = 200;

/** A subject is a sentence; the end of a line is not the place for all of one. */
const SUMMARY_LIMIT = 60;

export class InlineBlame {
  private readonly git: Git;

  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    // The annotation belongs to the line, not to the text: typing at the end of the line must push
    // it along rather than absorb it.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  /** The last blame asked for, per file, with the version of the text it was asked about. */
  private readonly cache = new Map<string, { version: number; blame: Promise<Blame> }>();

  /** Which repository each directory belongs to, or null for none. Directories do not move. */
  private readonly repos = new Map<string, Promise<RepoInfo | null>>();

  /** The editor currently wearing an annotation, so switching away takes it with it. */
  private decorated: vscode.TextEditor | null = null;

  private timer: NodeJS.Timeout | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(git: Git) {
    this.git = git;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.schedule();
        }
      }),
      /*
       * An edit moves lines, so the annotation beside the cursor is about a different line the
       * moment anything is typed. Clearing it now rather than waiting for the next blame keeps it
       * from sitting there saying something untrue for a fifth of a second.
       */
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.clear();
          this.schedule();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cache.delete(document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('weft.inlineBlame')) {
          this.clear();
          this.schedule();
        }
      }),
    );

    this.schedule();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    for (const d of this.disposables) {
      d.dispose();
    }

    this.decoration.dispose();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('weft').get<boolean>('inlineBlame', true);
  }

  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      /*
       * Swallowed on purpose, and this is the one place it is right to. This runs on a timer, so a
       * rejection has nowhere to go but the extension host's unhandled-rejection log - and what is
       * at stake is one line of grey text at the end of a line. A repository that cannot be blamed
       * shows no annotation, which is what it should look like anyway.
       */
      void this.refresh().catch(() => undefined);
    }, SETTLE_MS);
  }

  private clear(): void {
    this.decorated?.setDecorations(this.decoration, []);
    this.decorated = null;
  }

  private async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (this.decorated !== null && this.decorated !== editor) {
      this.clear();
    }

    // A settings page, an output channel, a diff of a revision Weft itself is serving: none of them
    // are files git has an opinion about.
    if (editor === undefined || editor.document.uri.scheme !== 'file' || !this.enabled()) {
      this.clear();
      return;
    }

    const document = editor.document;
    const line = editor.selection.active.line;
    const version = document.version;

    const repo = await this.repoOf(document.uri.fsPath);

    if (repo === null) {
      this.clear();
      return;
    }

    const blame = await this.blameOf(repo, document);

    /*
     * Everything above was awaited, so the editor may have moved on: a different file, a different
     * line, or an edit that makes this answer about the wrong text. Painting it anyway is how an
     * annotation ends up naming the author of a line nobody is looking at.
     */
    if (
      vscode.window.activeTextEditor !== editor ||
      editor.document.version !== version ||
      editor.selection.active.line !== line
    ) {
      return;
    }

    const entry = blame[line];

    if (entry === undefined) {
      this.clear();
      return;
    }

    const end = document.lineAt(line).range.end;

    this.decorated = editor;
    editor.setDecorations(this.decoration, [
      {
        range: new vscode.Range(end, end),
        renderOptions: { after: { contentText: label(entry) } },
        hoverMessage: hover(entry, repo.root),
      },
    ]);
  }

  private repoOf(path: string): Promise<RepoInfo | null> {
    const dir = dirname(path);
    const known = this.repos.get(dir);

    if (known !== undefined) {
      return known;
    }

    // Held as the promise rather than its result, so two files opened at once in the same folder
    // are one `rev-parse` and not two.
    const found = discover(this.git, dir).catch(() => null);

    this.repos.set(dir, found);
    return found;
  }

  private blameOf(repo: RepoInfo, document: vscode.TextDocument): Promise<Blame> {
    const key = document.uri.toString();
    const known = this.cache.get(key);

    if (known !== undefined && known.version === document.version) {
      return known.blame;
    }

    const blame = blameFile(
      this.git,
      repo,
      document.uri.fsPath,
      // Only when it would differ from the file on disk. Handing git a megabyte on stdin to be told
      // what it could have read itself is a cost with nothing on the other side of it.
      document.isDirty ? document.getText() : undefined,
    );

    this.cache.set(key, { version: document.version, blame });
    return blame;
  }
}

/** What goes at the end of the line. */
function label(entry: BlameLine): string {
  if (entry.uncommitted) {
    return 'You, uncommitted changes';
  }

  const summary =
    entry.summary.length > SUMMARY_LIMIT
      ? `${entry.summary.slice(0, SUMMARY_LIMIT - 1)}…`
      : entry.summary;

  const who = entry.author.length > 0 ? entry.author : 'Someone';
  const when = entry.authorTime > 0 ? `, ${describeAge(entry.authorTime)}` : '';

  return summary.length > 0 ? `${who}${when} • ${summary}` : `${who}${when}`;
}

/**
 * The same thing at length, and the way through to the graph.
 *
 * The link has to be here. A decoration’s trailing text is drawn, not built from elements, so
 * there is nothing to attach a click to - the hover is the only part of an annotation that can
 * hold one, which is why every editor that does this does it here.
 *
 * Trusted for exactly one command. A markdown string that will run commands is a small piece of
 * authority, and this one needs only the piece it uses.
 */
function hover(entry: BlameLine, root: string): vscode.MarkdownString {
  const text = new vscode.MarkdownString();

  if (entry.uncommitted) {
    text.appendMarkdown('Not committed yet.');
    return text;
  }

  text.isTrusted = { enabledCommands: ['weft.revealCommit'] };

  const when = entry.authorTime > 0 ? new Date(entry.authorTime).toISOString().slice(0, 10) : '';
  const args = encodeURIComponent(JSON.stringify([{ sha: entry.sha, root }]));

  text.appendMarkdown(`**${entry.summary}**\n\n`);
  text.appendMarkdown(`${entry.author} · ${when} · \`${entry.sha.slice(0, 8)}\`\n\n`);
  text.appendMarkdown(`[Show in the graph](command:weft.revealCommit?${args})`);
  return text;
}
