/**
 * Blame, drawn on the editor. Two annotations, one owner.
 *
 * **The line the cursor is on**, at the end of it. Always on, because "why is this here" is asked
 * about the line being read and answering it should not cost a gesture.
 *
 * **Every line**, in a column down the left, and only when asked for. That one changes what the
 * file looks like to work in - the code moves right and a second column competes with it for the
 * eye - so it is a thing you turn on to read a file's history and turn off to go back to writing
 * it. Per file, because turning it on for one is not a statement about the next.
 *
 * They share the blame rather than each asking for their own: it is the same question about the
 * same text, keyed on the document's version, so the two annotations cost one `git blame` between
 * them and moving about inside unchanged text costs none.
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

/** How long to stand back while the repository is being written to, before asking again. */
const BUSY_MS = 500;

/** A subject is a sentence; the end of a line is not the place for all of one. */
const SUMMARY_LIMIT = 60;

/** How much of a name the column shows before it gives up and truncates. */
const NAME_WIDTH = 16;

/** Padding that survives being rendered as a decoration, where ordinary runs of spaces do not. */
const PAD = ' ';

export class BlameAnnotations {
  private readonly git: Git;

  /**
   * Whether a write is in flight against a repository.
   *
   * This has to know, and it is the one thing here that is not about editors. A checkout rewrites
   * the files that are open, VS Code reloads those documents, and the reload is a change event -
   * so without this, a checkout is the exact moment this runs `git blame`, over and over, on the
   * repository being checked out. On Windows that is what turns a checkout into
   * `unable to write symref for HEAD`, with the branch left behind and the whole diff staged.
   */
  private readonly isBusy: (root: string) => boolean;

  /** The one at the end of the line the cursor is on. */
  private readonly lineDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    // The annotation belongs to the line, not to the text: typing at the end of the line must push
    // it along rather than absorb it.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  /** The column down the left, when a file has asked for one. */
  private readonly fileDecoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 1.5em 0 0',
    },
    /*
     * The column is drawn in front of the first character, so an edit at the start of a line would
     * otherwise swallow it. Nothing here is part of the text.
     */
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  /**
   * The blames asked for, per file, with the version of the text they were asked about: the whole
   * file once the column wants it, and single lines for the annotation at the end of one.
   */
  private readonly cache = new Map<
    string,
    { version: number; full: Promise<Blame> | null; lines: Map<number, Promise<Blame>> }
  >();

  /** The one-line blame being waited for, stopped when the cursor moves on before it answers. */
  private inflight: AbortController | null = null;

  /** Which repository each directory belongs to, or null for none. Directories do not move. */
  private readonly repos = new Map<string, Promise<RepoInfo | null>>();

  /** The documents showing the whole-file column, by URI. */
  private readonly annotated = new Set<string>();

  /** The editor currently wearing annotations, so switching away takes them with it. */
  private decorated: vscode.TextEditor | null = null;

  private timer: NodeJS.Timeout | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(git: Git, isBusy: (root: string) => boolean) {
    this.git = git;
    this.isBusy = isBusy;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.schedule();
        }
      }),
      /*
       * An edit moves lines, so both annotations are about different lines the moment anything is
       * typed. Clearing them now rather than waiting for the next blame keeps them from sitting
       * there saying something untrue for a fifth of a second.
       */
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.clear();
          this.schedule();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const key = document.uri.toString();

        this.cache.delete(key);
        // Closing a file is the end of asking about it. Reopening it starts from the default.
        this.annotated.delete(key);
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

    this.lineDecoration.dispose();
    this.fileDecoration.dispose();
  }

  /**
   * Show or hide the whole-file column for the file in front.
   *
   * Toggled per document rather than globally: it is turned on to read one file's history, and
   * leaving every other file annotated afterwards is not what was asked for.
   */
  toggleFile(): void {
    const editor = vscode.window.activeTextEditor;

    if (editor === undefined) {
      return;
    }

    const key = editor.document.uri.toString();

    if (this.annotated.delete(key)) {
      editor.setDecorations(this.fileDecoration, []);
      return;
    }

    this.annotated.add(key);
    this.schedule();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('weft').get<boolean>('inlineBlame', true);
  }

  private schedule(delay: number = SETTLE_MS): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      /*
       * Swallowed on purpose, and this is the one place it is right to. This runs on a timer, so a
       * rejection has nowhere to go but the extension host's unhandled-rejection log - and what is
       * at stake is grey text beside some code. A repository that cannot be blamed shows no
       * annotation, which is what it should look like anyway.
       */
      void this.refresh().catch(() => undefined);
    }, delay);
  }

  private clear(): void {
    this.decorated?.setDecorations(this.lineDecoration, []);
    this.decorated?.setDecorations(this.fileDecoration, []);
    this.decorated = null;
  }

  private async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (this.decorated !== null && this.decorated !== editor) {
      this.clear();
    }

    // A settings page, an output channel, a diff of a revision Weft itself is serving: none of them
    // are files git has an opinion about.
    if (editor === undefined || editor.document.uri.scheme !== 'file') {
      this.clear();
      return;
    }

    const document = editor.document;
    const wanted = this.annotated.has(document.uri.toString());

    // The column is asked for explicitly, so it outlives the setting that governs the quiet one.
    if (!this.enabled() && !wanted) {
      this.clear();
      return;
    }

    const line = editor.selection.active.line;
    const version = document.version;
    const repo = await this.repoOf(document.uri.fsPath);

    if (repo === null) {
      this.clear();
      return;
    }

    /*
     * Not while the repository is being written to. Coming back in half a second is free; running
     * git against a checkout in progress is how the checkout fails.
     */
    if (this.isBusy(repo.root)) {
      this.schedule(BUSY_MS);
      return;
    }

    // The one before, still running for a line the cursor has left, is not worth finishing.
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;

    let blame: Blame;

    try {
      blame = await this.blameOf(repo, document, wanted ? null : line, controller.signal);
    } catch {
      // Stopped for a newer question: that question paints, not this one.
      return;
    } finally {
      if (this.inflight === controller) {
        this.inflight = null;
      }
    }

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

    this.decorated = editor;
    this.paintLine(editor, blame, line, repo.root);
    this.paintFile(editor, blame, wanted, repo.root);
  }

  private paintLine(
    editor: vscode.TextEditor,
    blame: Blame,
    line: number,
    root: string,
  ): void {
    const entry = this.enabled() ? blame[line] : undefined;

    if (entry === undefined) {
      editor.setDecorations(this.lineDecoration, []);
      return;
    }

    const end = editor.document.lineAt(line).range.end;

    editor.setDecorations(this.lineDecoration, [
      {
        range: new vscode.Range(end, end),
        renderOptions: { after: { contentText: lineLabel(entry) } },
        hoverMessage: hover(entry, root),
      },
    ]);
  }

  private paintFile(
    editor: vscode.TextEditor,
    blame: Blame,
    wanted: boolean,
    root: string,
  ): void {
    if (!wanted) {
      editor.setDecorations(this.fileDecoration, []);
      return;
    }

    const width = columnWidth(blame);
    const options: vscode.DecorationOptions[] = [];

    for (let line = 0; line < editor.document.lineCount; line++) {
      const entry = blame[line];

      // Every line gets one, including the ones with nothing to say: a column with holes in it
      // stops being a column, and the code beside it would step in and out as you read down.
      const start = new vscode.Position(line, 0);

      options.push({
        range: new vscode.Range(start, start),
        renderOptions: { before: { contentText: columnLabel(entry, width) } },
        ...(entry === undefined ? {} : { hoverMessage: hover(entry, root) }),
      });
    }

    editor.setDecorations(this.fileDecoration, options);
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

  /**
   * The blame of the whole file when `line` is null, and of that one line otherwise - kept for the
   * version of the text either way.
   *
   * Only a one-line blame is stopped when the cursor moves on. The whole file is the column's, which
   * wants every line whichever one the cursor is on, and a cursor held moving down a long file would
   * otherwise restart it until the column never came at all. A stopped blame is forgotten rather
   * than kept, so the next time its line is asked about it is asked again, not handed a rejection.
   */
  private blameOf(
    repo: RepoInfo,
    document: vscode.TextDocument,
    line: number | null,
    signal: AbortSignal,
  ): Promise<Blame> {
    const key = document.uri.toString();
    let entry = this.cache.get(key);

    if (entry === undefined || entry.version !== document.version) {
      entry = { version: document.version, full: null, lines: new Map() };
      this.cache.set(key, entry);
    }

    // The whole file answers every line, so a line asked about after it is already known.
    const known = entry.full ?? (line === null ? undefined : entry.lines.get(line));

    if (known !== undefined) {
      return known;
    }

    const blame = blameFile(
      this.git,
      repo,
      document.uri.fsPath,
      // Only when it would differ from the file on disk. Handing git a megabyte on stdin to be told
      // what it could have read itself is a cost with nothing on the other side of it.
      document.isDirty ? document.getText() : undefined,
      line === null ? {} : { line, signal },
    );

    const kept = entry;

    if (line === null) {
      kept.full = blame;
    } else {
      kept.lines.set(line, blame);

      blame.catch(() => {
        if (kept.lines.get(line) === blame) {
          kept.lines.delete(line);
        }
      });
    }

    return blame;
  }
}

/** What goes at the end of the line the cursor is on. */
function lineLabel(entry: BlameLine): string {
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
 * How wide the column has to be for its widest entry.
 *
 * Measured rather than fixed, because a repository of `nick_huang` and one of
 * `A02-01557\\Inoc_Chen` want different columns and the ragged right edge of a guess is what makes
 * a column stop reading as one.
 */
function columnWidth(blame: Blame): number {
  let width = 0;

  for (const entry of blame) {
    if (entry !== undefined) {
      width = Math.max(width, columnText(entry).length);
    }
  }

  return Math.min(width, NAME_WIDTH + 11);
}

/** `<author> <date>`, which is what a column of blame is for: who, and roughly when. */
function columnText(entry: BlameLine): string {
  if (entry.uncommitted) {
    return 'You  uncommitted';
  }

  const who = entry.author.length > 0 ? entry.author : 'Someone';
  const name = who.length > NAME_WIDTH ? `${who.slice(0, NAME_WIDTH - 1)}…` : who;
  const when = entry.authorTime > 0 ? new Date(entry.authorTime).toISOString().slice(0, 10) : '';

  return `${name} ${when}`.trim();
}

function columnLabel(entry: BlameLine | undefined, width: number): string {
  const text = entry === undefined ? '' : columnText(entry);
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text;

  // Padded rather than laid out: a decoration is one run of text, so the only way to make a column
  // of them line up is to make every one of them the same length.
  return clipped.padEnd(width, PAD).replace(/ /g, PAD);
}

/**
 * The commit at length, and the way through to the graph.
 *
 * The link has to be here. A decoration's text is drawn, not built from elements, so there is
 * nothing to attach a click to - the hover is the only part of an annotation that can hold one,
 * which is why every editor that does this does it here.
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
