/**
 * Loads the built extension with a stubbed `vscode` module and drives it end to end.
 *
 * This is the check that "it fails to load" and "the command is dead" cannot survive. It exercises
 * the real CommonJS bundle VS Code will require, calls `activate`, invokes `weft.openGraph`, and
 * replays the webview handshake - so everything except VS Code's own chrome is covered before
 * anyone presses F5.
 *
 *   node scripts/load-check.mjs [repo]
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watchTest = process.argv.includes('--watch');
const given = process.argv.slice(2).find((a) => !a.startsWith('--'));

/** A throwaway repository, so the watcher test can commit into it without touching anything real. */
function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'weft-watch-')).split('\\').join('/');
  runGit(dir, 'init', '-q', '-b', 'main');
  runGit(dir, 'config', 'user.name', 'Weft Test');
  runGit(dir, 'config', 'user.email', 'test@example.invalid');
  runGit(dir, 'config', 'commit.gpgsign', 'false');
  runGit(dir, 'config', 'core.autocrlf', 'false');

  for (const n of [1, 2, 3]) {
    commitInto(dir, n);
  }

  // A second author, so filtering by one of them has something to remove.
  runGit(dir, 'config', 'user.name', 'Someone Else');
  runGit(dir, 'config', 'user.email', 'else@example.invalid');
  commitInto(dir, 4);
  runGit(dir, 'config', 'user.name', 'Weft Test');
  runGit(dir, 'config', 'user.email', 'test@example.invalid');

  // A side branch with a commit of its own, so the ref filter has something to remove.
  runGit(dir, 'checkout', '-q', '-b', 'side');
  commitInto(dir, 9);
  runGit(dir, 'checkout', '-q', 'main');

  // A tag, so the Branches & Tags section has all three kinds of ref in it. Without one, anything
  // asking what a tag looks like gets the group node above it and quietly checks the wrong thing.
  runGit(dir, 'tag', 'v1.0');

  return dir;
}

function runGit(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** The same, with a committer date. A fixture built in one second cannot be sorted by time. */
function runGitAt(dir, when, ...args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
  });
}

function commitInto(dir, n) {
  writeFileSync(join(dir, 'f' + n + '.txt'), 'content ' + n + '\n');
  runGit(dir, 'add', '-A');
  runGit(dir, 'commit', '-q', '-m', 'commit ' + n);
}

const repoPath = given ?? makeTempRepo();

/** `--break-view=<id>`: make one view id unknown, the way a stale manifest does. */
const breakView = process.argv.find((a) => a.startsWith('--break-view='))?.slice('--break-view='.length) ?? null;

const commands = new Map();
const posted = [];
const outputLines = [];
let messageHandler = null;
let panelCreated = null;
const problems = [];
const contentProviders = new Map();
const diffsOpened = [];
const contextKeys = new Map();
const copied = [];
/** Addresses handed to the operating system to open. */
const opened = [];
const confirmations = [];
const progressTitles = [];
const statusMessages = [];

/** Whether the stub says yes to a confirmation. A run needs both answers to prove a refusal. */
let confirmed = true;

/*
 * What the next input boxes answer, in order; an empty queue dismisses. Dismissing is what the check
 * that brought this in is about: an action whose own question goes unanswered must end right there.
 */
const inputAnswers = [];

/** Information messages that came with buttons - questions, however politely asked - and their answers. */
const offers = [];
const infoAnswers = [];

/** What each quick pick offered, and the labels to answer the next ones with - none left is Escape. */
const picks = [];
const pickAnswers = [];

/**
 * Waits for something to become true, rather than for a length of time.
 *
 * Polls every 25 ms up to `ms` and answers whether it ever held, so a caller that has nothing else
 * to assert can say so itself. The predicate has to be cheap - it runs forty times a second on the
 * same thread the extension is working on, so reading `posted` or a tree is fine and spawning a git
 * process is not.
 */
const until = async (test, ms = 20_000) => {
  const by = Date.now() + ms;

  while (Date.now() < by) {
    if (test()) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 25));
  }

  return false;
};

/**
 * How long a walk took, waited for rather than guessed at.
 *
 * `from` is how many `done` messages had arrived before whatever was asked for; this returns once
 * there is another one, and hands back its total so the caller can compare counts.
 *
 * `ms` bounds the wait. The default is longer than any walk here takes, and is what to use when the
 * walk is the thing being measured. `SETTLING` is for the calls that put the graph back to a known
 * state between sections: Show All walks only if something was unticked, Show Only This Branch only
 * if something else was ticked, and either can be handed a graph already in that state - so a wait
 * for a walk that was never owed would have nothing to do but run out. It is the longest any of
 * those used to sleep for unconditionally, so a restore is never given less time than it had.
 */
const SETTLING = 1_500;

const settle = async (from, ms = 20_000) => {
  await until(() => posted.filter((m) => m.type === 'done').length > from, ms);
  return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
};

/**
 * The one thing a predicate cannot wait for: that something does *not* happen.
 *
 * Every other wait in this file is a condition - a walk that landed, a message that arrived, a
 * branch that left the sidebar - and finishes the moment it holds. A check that nothing reloaded,
 * nothing re-walked, nothing repainted has no such moment: the only evidence is time passing with
 * the counter still where it was. So these stay as a sleep, and each one says below why it is one.
 *
 * The default is twice the watcher's 600 ms debounce, which is the slowest path from a change to a
 * reload; a wait shorter than that would pass by arriving before the thing it is ruling out.
 */
const quiet = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

/*
 * Settings, so that a default is not the only value any of them can have. Every `get` used to
 * return the fallback it was handed, which meant the branches behind a non-default - a hidden
 * status bar, a timer that is switched on - could not be reached at all.
 */
const settings = new Map();

/*
 * Intervals, recorded rather than scheduled. The one interval Braid sets is the auto-fetch, whose
 * shortest period is a minute; a test cannot wait for it, but it can insist that asking for five
 * minutes schedules five minutes and asking for none schedules nothing.
 */
const intervals = [];
const realSetInterval = globalThis.setInterval;

globalThis.setInterval = (fn, ms, ...rest) => {
  intervals.push({ ms, fn });
  return { stub: true, ms };
};

globalThis.clearInterval = (handle) => {
  if (handle?.stub !== true) {
    return realSetInterval === undefined ? undefined : clearTimeout(handle);
  }

  return undefined;
};

let statusBarItem = null;
let viewStateHandler = null;
let disposeHandler = null;
let panelObject = null;
let quickPick = null;

/** Webview panels other than the graph's - the statistics tab - each with what it was sent and its handler. */
const otherPanels = [];

/**
 * What VS Code does to checkboxes when the extension has not claimed them.
 *
 * Unless `manageCheckboxStateManually` is set, the tree view owns checkbox state and reads a ticked
 * parent as "every child is ticked", driving them all back on at the next render. A stub that never
 * did this is a stub in a state real VS Code is never in - and it is how a provider that reports a
 * group as ticked whenever *any* of its refs are showing passed here while putting the tick
 * straight back on screen.
 */
function propagateCheckboxes(id) {
  const provider = treeProviders.get(id);
  const handler = checkboxHandlers.get(id);

  if (provider === undefined || handler === undefined || treeViewOptions.get(id)?.manageCheckboxStateManually === true) {
    return;
  }

  for (const parent of provider.getChildren()) {
    const children = provider.getChildren(parent);

    if (children.length > 0) {
      const state = provider.getTreeItem(parent).checkboxState;
      handler({ items: children.map((child) => [child, state]) });
    }
  }
}

/** Drive the ref filter picker the way a user would: type, then accept. */
async function typeIntoRefFilter(text) {
  await commands.get('weft.filterRefs')();
  quickPick.picker.value = text;
  quickPick.handlers.change?.(text);
  quickPick.handlers.accept?.();
}
const treeProviders = new Map();
const treeViewOptions = new Map();
const checkboxHandlers = new Map();
const treeViews = new Map();

class StubEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { for (const l of [...this.listeners]) l(v); }
  dispose() {}
}

/** The built-in git extension, which is where Weft learns about things it cannot watch itself. */
const repositoryState = new StubEmitter();
const repositoryOpened = new StubEmitter();
const repositoryClosed = new StubEmitter();

/** Settings changing, which nothing here could make happen before. */
const configurationChanged = {
  listeners: [],
  fire(changed) {
    for (const fn of [...this.listeners]) {
      fn({ affectsConfiguration: (key) => changed.some((c) => c === key || key.startsWith(c)) });
    }
  },
};

const uri = (p) => ({
  fsPath: p,
  scheme: 'file',
  path: p,
  toString: () => `file://${p}`,
});

/*
 * An editor, for the line-end blame. It watches the window rather than the graph, so without these
 * the extension does not finish activating at all - and everything after that is a null.
 */
const activeEditorChanged = new StubEmitter();
const selectionChanged = new StubEmitter();
const documentChanged = new StubEmitter();
const documentClosed = new StubEmitter();

/** What the blame annotation was last asked to draw, so a test can read it back. */
const decorations = [];
const terminalProviders = [];
const codeLensProviders = [];
const customEditors = [];

/** Documents a custom editor is allowed to write into, by path: the stand-in for a file on disk. */
const editableDocuments = new Map();

/**
 * Whether `applyEdit` should refuse, which only the rebase editor's section turns on. A workspace that
 * says no to an edit is a real answer - a read-only file, a document closed under it - and what the
 * editor does about it is the thing being checked.
 */
let refusingEdits = () => false;

const setRefusingEdits = (fn) => void (refusingEdits = fn);

const editorDocument = {
  uri: uri(repoPath.replace(/\\/g, '/') + '/f1.txt'),
  version: 1,
  isDirty: false,
  getText: () => 'one\n',
  lineAt: (line) => ({ range: { end: { line, character: 0 } } }),
  // The whole-file column walks this, so a document without it is a column with no lines in it.
  lineCount: 1,
};

const activeEditor = {
  document: editorDocument,
  selection: { active: { line: 0 }, start: { line: 0 }, end: { line: 0 } },
  setDecorations: (_type, ranges) => decorations.push(ranges),
};

const vscodeStub = {
  Uri: {
    file: uri,
    joinPath: (base, ...parts) => uri([base.fsPath, ...parts].join('/')),
    from: (parts) => ({ ...parts, fsPath: parts.path, toString: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}` }),
  },
  ViewColumn: { Active: -1, One: 1 },
  // Where a setting is written, for the commands that fill one in on the user's behalf.
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: {
    registerCommand: (id, fn) => {
      if (commands.has(id)) {
        problems.push(`command registered twice: ${id}`);
      }

      commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => {
      if (id === 'vscode.diff') {
        diffsOpened.push({ left: args[0], right: args[1], title: args[2] });
      }
      if (id === 'setContext') {
        contextKeys.set(args[0], args[1]);
      }
      return undefined;
    },
  },
  window: {
    /*
     * A window with a file open, which is the ordinary one. Its path was being handed to git as a
     * working directory - a file is not a directory, Node calls that `spawn git ENOENT`, and the
     * rejection took `weft.hasRepository` with it. Every section in Source Control disappeared,
     * while the graph itself kept working, because opening that has no editor focused.
     */
    activeTextEditor: activeEditor,
    onDidChangeActiveTextEditor: activeEditorChanged.event,
    onDidChangeTextEditorSelection: selectionChanged.event,
    createTextEditorDecorationType: () => ({ dispose() {} }),
    registerTerminalLinkProvider: (provider) => {
      terminalProviders.push(provider);
      return { dispose() {} };
    },
    registerCustomEditorProvider: (viewType, provider, options) => {
      customEditors.push({ viewType, provider, options });
      return { dispose() {} };
    },
    createOutputChannel: () => ({
      info: (m) => outputLines.push(`info  ${m}`),
      warn: (m) => outputLines.push(`warn  ${m}`),
      error: (m) => outputLines.push(`error ${m}`),
      debug: (m) => outputLines.push(`debug ${m}`),
      show() {},
      dispose() {},
    }),
    /*
     * With buttons, an information message is a question: recorded, and answered from infoAnswers -
     * an empty queue closing it, the way dismissing a notification does. Without them it is a
     * message nothing here expects.
     */
    showInformationMessage: async (m, ...choices) => {
      const buttons = choices.filter((choice) => typeof choice === 'string');

      if (buttons.length === 0) {
        problems.push(`unexpected info message: ${m}`);
        return undefined;
      }

      offers.push({ message: m, buttons });
      return infoAnswers.shift();
    },
    /*
     * A warning with buttons is a confirmation, and this answers it with the first one - which is
     * how a user gets past `ui.confirm`. Until this existed every confirmation returned undefined,
     * every tier-2 action read that as "cancelled", and nothing that asks before it acts had ever
     * run to completion here.
     *
     * A warning with no buttons is still nobody's plan, and still a failure.
     */
    showWarningMessage: async (m, options, ...choices) => {
      /*
       * Both of VS Code's shapes. The options object is optional, and a string in its place is the
       * first button - which is how the extension's own `Show Log` warnings are written. The stub
       * knew only the longer shape, so a warning offering buttons the ordinary way read here as a
       * warning offering none, which is a failure.
       */
      const buttons = typeof options === 'string' ? [options, ...choices] : choices;

      if (buttons.length === 0) {
        problems.push(`unexpected warning: ${m}`);
        return undefined;
      }

      confirmations.push({
        message: m,
        detail: typeof options === 'string' ? '' : (options?.detail ?? ''),
        answered: buttons[0],
      });
      return confirmed ? buttons[0] : undefined;
    },
    // An input box, answered from inputAnswers and dismissed when nothing is queued.
    showInputBox: async () => inputAnswers.shift(),
    showQuickPick: async (items, options) => {
      const list = await items;
      const label = (item) => (typeof item === 'string' ? item : item.label);

      picks.push({
        title: options?.title ?? '',
        labels: list.map(label),
        ticked: list.filter((item) => item.picked === true).map(label),
      });

      const want = pickAnswers.shift();

      // Several at once, answered with the labels ticked when it was accepted; nothing queued is Escape.
      if (options?.canPickMany === true) {
        return want === undefined ? undefined : list.filter((item) => want.includes(label(item)));
      }

      return list.find((item) => label(item) === want);
    },
    // Activation reports its own failure through this one, so it has to exist here - and anything
    // arriving on it is a failure by definition.
    showErrorMessage: async (m) => {
      problems.push(`unexpected error message: ${m}`);
      return undefined;
    },
    setStatusBarMessage: (message) => {
      statusMessages.push(message);
      return { dispose() {} };
    },

    /*
     * Runs the work, which is the whole of what a progress notification does that matters here. The
     * token never cancels: nothing in this run is cancelled, and a token that fires would be
     * inventing a user who pressed something.
     */
    withProgress: (options, task) => {
      progressTitles.push(options.title);
      return task({ report() {} }, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      });
    },
    createQuickPick: () => {
      const handlers = {};
      const picker = {
        title: '', placeholder: '', value: '', items: [], selectedItems: [],
        matchOnDescription: false, matchOnDetail: false,
        onDidChangeValue: (fn) => { handlers.change = fn; return { dispose() {} }; },
        onDidAccept: (fn) => { handlers.accept = fn; return { dispose() {} }; },
        onDidHide: (fn) => { handlers.hide = fn; return { dispose() {} }; },
        show() { quickPick = { picker, handlers }; },
        hide() { handlers.hide?.(); },
        dispose() {},
      };
      return picker;
    },
    createTreeView: (id, options) => {
      // A stale manifest, on demand: see the self-test below for what this is proving.
      if (breakView === id) throw new Error(`No view is registered with id: ${id}`);
      treeProviders.set(id, options.treeDataProvider);
      treeViewOptions.set(id, options);
      const view = {
        message: undefined,
        onDidChangeCheckboxState: (fn) => { checkboxHandlers.set(id, fn); return { dispose() {} }; },
        dispose() {},
      };
      treeViews.set(id, view);
      return view;
    },
    createStatusBarItem: (id, alignment, priority) => {
      statusBarItem = { id, alignment, priority, visible: false };
      return {
        set name(v) { statusBarItem.name = v; },
        set text(v) { statusBarItem.text = v; },
        set tooltip(v) { statusBarItem.tooltip = v; },
        set command(v) { statusBarItem.command = v; },
        show() { statusBarItem.visible = true; },
        hide() { statusBarItem.visible = false; },
        dispose() {},
      };
    },
    createWebviewPanel: (viewType, title, _column, options) => {
      /*
       * Every check here talks to the graph through the globals below. Any other panel - the statistics
       * tab - is kept to itself, so that opening one cannot take the graph's place in them.
       */
      if (viewType !== 'weft.graph') {
        const record = { viewType, title, options, html: '', posted: [], handler: null, disposed: null };
        otherPanels.push(record);

        return {
          active: false,
          visible: true,
          webview: {
            cspSource: 'vscode-webview://stub',
            set html(value) {
              record.html = value;
            },
            get html() {
              return record.html;
            },
            asWebviewUri: (u) => u,
            postMessage: (m) => {
              record.posted.push(m);
              return Promise.resolve(true);
            },
            onDidReceiveMessage: (fn) => {
              record.handler = fn;
              return { dispose() {} };
            },
          },
          onDidChangeViewState: () => ({ dispose() {} }),
          onDidDispose: (fn) => {
            record.disposed = fn;
            return { dispose() {} };
          },
          reveal() {},
          dispose() {
            record.disposed?.();
          },
        };
      }

      panelCreated = { viewType, title, options };
      return (panelObject = {
        active: true,
        webview: {
          cspSource: 'vscode-webview://stub',
          set html(value) {
            this._html = value;
          },
          get html() {
            return this._html;
          },
          asWebviewUri: (u) => u,
          postMessage: (m) => {
            posted.push(m);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: (fn) => {
            messageHandler = fn;
            return { dispose() {} };
          },
        },
        onDidChangeViewState: (fn) => { viewStateHandler = fn; return { dispose() {} }; },
        onDidDispose: (fn) => { disposeHandler = fn; return { dispose() {} }; },
        reveal() {},
        dispose() {},
      });
    },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  // Real values, because `ui.progress` reads one of them. Without these every action that reports
  // progress - which is every action that touches the repository - threw before it started.
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  EventEmitter: StubEmitter,
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(v) { this.value += v; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  WorkspaceEdit: class {
    constructor() {
      this.changes = [];
    }

    replace(uri, range, text) {
      this.changes.push({ uri, range, text });
    }
  },
  CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
  languages: {
    registerCodeLensProvider: (selector, provider) => {
      codeLensProviders.push({ selector, provider });
      return { dispose() {} };
    },
  },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  workspace: {
    workspaceFolders: [{ uri: uri(repoPath) }],
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const full = section === undefined ? key : `${section}.${key}`;
        return settings.has(full) ? settings.get(full) : fallback;
      },
      /*
       * Writing one, which the stub could not do at all - so anything that filled a setting in for the
       * user was unreachable here. The real one writes the file and tells everybody watching, and the
       * telling is the half that matters: a command that writes a setting and leaves the window holding
       * the old one is indistinguishable from a command that did nothing.
       */
      update: async (key, value) => {
        const full = section === undefined ? key : `${section}.${key}`;

        if (value === undefined) {
          settings.delete(full);
        } else {
          settings.set(full, value);
        }

        configurationChanged.fire([full]);
      },
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    /*
     * The real one writes the document and tells everybody watching. Both halves matter here: an editor
     * that writes a file and never hears about it draws the list it had before the change.
     */
    applyEdit: async (edit) => {
      /*
       * Never synchronous, because the real one never is: it crosses to the extension host and back.
       * Applying the moment it is asked would hide every race an editor has to survive - two messages
       * arriving together would each find the other's work already done, and the harness would say
       * an editor was safe that is only safe here.
       */
      await new Promise((r) => setTimeout(r, 5));

      if (refusingEdits()) {
        return false;
      }

      for (const change of edit?.changes ?? []) {
        const document = editableDocuments.get(String(change.uri?.fsPath ?? change.uri));

        if (document !== undefined) {
          document.setText(change.text);
          documentChanged.fire({ document });
        }
      }

      return true;
    },
    onDidChangeTextDocument: documentChanged.event,
    onDidCloseTextDocument: documentClosed.event,
    onDidChangeConfiguration: (fn) => {
      configurationChanged.listeners.push(fn);
      return { dispose() {} };
    },
    registerTextDocumentContentProvider: (scheme, provider) => {
      contentProviders.set(scheme, provider);
      return { dispose() {} };
    },
  },
  extensions: {
    /*
     * Present and active, which is the ordinary state of a VS Code window. Returning undefined
     * meant `vscodeGit.ts` never got past its first null check - so neither the repository events
     * that make the Source Control sections appear after a `git init`, nor the working-tree events
     * the uncommitted row keeps up with, had ever run a line here.
     */
    getExtension: (id) =>
      id === 'vscode.git'
        ? {
            isActive: true,
            exports: {
              getAPI: () => ({
                repositories: [
                  {
                    /*
                     * The same directory, spelled differently on purpose.
                     *
                     * Weft's root comes from `git rev-parse --show-toplevel` and this one does not,
                     * which is the whole reason the two have to be compared as paths rather than as
                     * text. On this machine `mkdtemp` already hands back `C:/Users/MARTIN~1/...`
                     * where git hands back `C:/Users/Martin_Wang/...` - but 8.3 short names are a
                     * Windows accident, so the divergence is made deliberate here as well and the
                     * assertion means the same thing on every machine.
                     */
                    rootUri: uri(repoPath.replace(/\\/g, '/') + '/.git/..'),
                    state: {
                      onDidChange: repositoryState.event,
                      // Read from the repository itself, as the git extension's own is.
                      get HEAD() {
                        return { commit: runGit(repoPath, 'rev-parse', 'HEAD').trim() };
                      },
                    },
                  },
                ],
                onDidOpenRepository: repositoryOpened.event,
                onDidCloseRepository: repositoryClosed.event,
              }),
            },
          }
        : undefined,
  },
  env: {
    clipboard: { writeText: async (text) => void copied.push(text) },
    openExternal: async (target) => {
      opened.push(String(target));
      return true;
    },
  },
};

// The bundle does `require('vscode')`, which only exists inside the extension host.
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  return originalLoad.call(this, request, parent, isMain);
};

/*
 * This runs the built bundle, not the sources, so a stale dist/ silently checks the wrong code -
 * which has already cost one round of "but I fixed that". `npm test` builds first; a direct run
 * might not have.
 */
{
  const bundle = statSync(resolve('dist/extension.js'), { throwIfNoEntry: false });

  if (bundle === undefined) {
    console.error('dist/extension.js is missing - run `npm run build` first.');
    process.exit(1);
  }

  const newest = readdirSync(resolve('src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);

  if (newest > bundle.mtimeMs) {
    console.error('dist/extension.js is older than src/ - run `npm run build` first.');
    process.exit(1);
  }
}

const require_ = createRequire(import.meta.url);
const extension = require_(resolve('dist/extension.js'));

console.log('exports        :', Object.keys(extension).join(', '));

const memory = new Map();
const workspaceMemory = new Map();

const context = {
  subscriptions: [],
  extensionUri: uri(resolve('.').replace(/\\/g, '/')),
  globalState: {
    get: (key, fallback) => memory.get(key) ?? fallback,
    update: async (key, value) => void memory.set(key, value),
  },
  /*
   * The workspace's own memory. Hand-made author groups live here, and a context without it is an
   * extension that cannot finish pointing itself at a repository - which is every section gone.
   */
  workspaceState: {
    get: (key, fallback) => workspaceMemory.get(key) ?? fallback,
    update: async (key, value) => void workspaceMemory.set(key, value),
    keys: () => [...workspaceMemory.keys()],
  },
};
extension.activate(context);

/*
 * Until the extension has found the repository it was activated over, or has said it could not
 * activate at all.
 *
 * Not until `Weft activated` is in the log: that line is written while the pass that discovers the
 * repository is still running - `void updatePresence()` - so a run that waits for it finds no
 * `weft.hasRepository`, a status bar still hidden and an empty refs tree, and blames the extension
 * for all three. The end of that pass is the refs view having been pointed at something, which is
 * the last thing it does.
 */
await until(
  () =>
    outputLines.some((line) => line.includes('Weft failed to activate')) ||
    (contextKeys.has('weft.hasRepository') && (treeProviders.get('weft.refs')?.listRefs().length ?? 0) > 0),
);

/*
 * Activation is all or nothing: everything below is meaningless if `activate` threw on the way
 * through, and it used to fail without saying so.
 */
if (!outputLines.some((line) => line.includes('Weft activated'))) {
  problems.push('activate() did not run to completion');
}

/*
 * A self-test of the guard around activation, run as its own process with `--break-view=<id>`.
 *
 * It reproduces a window whose manifest is older than its code - `createTreeView` throwing for a
 * view that window has never heard of - which is how adding a view and not restarting the
 * Extension Development Host used to look: no commands, no `weft.hasRepository`, all three
 * Source Control sections gone, and not a word about any of it.
 */
if (breakView !== null) {
  const logged = outputLines.some((line) => line.includes('Weft failed to activate'));
  const shown = problems.some((p) => p.includes('unexpected error message'));

  console.log('broken view    :', breakView, '|', logged ? 'logged' : 'NOT LOGGED', '|', shown ? 'shown to the user' : 'NOT SHOWN');

  if (!logged || !shown) {
    console.error('\nFAILED: a failed activation said nothing.');
    process.exit(1);
  }

  console.log('\nOK - a failed activation reports itself.');
  process.exit(0);
}

console.log('commands       :', [...commands.keys()].join(', '));
console.log('status bar     :', statusBarItem === null ? 'NOT CREATED' : JSON.stringify({ text: statusBarItem.text, command: statusBarItem.command, visible: statusBarItem.visible }));

if (statusBarItem === null) {
  problems.push('no status bar item was created');
} else {
  if (statusBarItem.command !== 'weft.openGraph') problems.push('status bar item runs the wrong command: ' + statusBarItem.command);
  if (!statusBarItem.visible) problems.push('status bar item stayed hidden in a real repository');
}

/*
 * The two Source Control sections are contributed with `when: weft.hasRepository`, so this key is
 * the whole of their visibility. A key that never arrives is an extension with no sidebar at all,
 * and nothing else in this run would notice.
 */
console.log('context keys   :', JSON.stringify(Object.fromEntries(contextKeys)));

if (contextKeys.get('weft.hasRepository') !== true) {
  problems.push('weft.hasRepository was not set in a real repository (is a file being used as a working directory?)');
}

/*
 * And it found it on the first try. Surviving a bad candidate is the safety net; not producing one
 * is the fix - the open file's *folder* is what git can be run in, and the file itself is not.
 */
const unusable = outputLines.filter((line) => line.includes('not a usable folder'));

if (unusable.length > 0) {
  problems.push(`discovery was handed something it could not use: ${unusable[0]}`);
}

console.log('subscriptions  :', context.subscriptions.length);

/*
 * Every contributed command must actually be registered. Read from package.json rather than a list
 * kept here, because the failure this catches is exactly a list going stale: `weft.refresh` once
 * shipped in the manifest with nothing behind it, and a hand-maintained expectation would have to
 * be updated by the same person who forgot the registration.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const contributed = manifest.contributes.commands.map((entry) => entry.command);

console.log('contributed    :', contributed.length, 'commands');

/*
 * A title bar is icons with no labels, and VS Code draws no separator between them - the overflow
 * menu is the only place a group can be seen as one. So the only thing keeping that row readable
 * is its length, and it had reached nine before anybody counted.
 *
 * Five: finding a name, applying that listing to the graph, and the three answers to "what should
 * the graph draw". Anything else belongs behind the ellipsis, where it can at least be read.
 */
{
  const icons = (manifest.contributes.menus['view/title'] ?? []).filter(
    (entry) =>
      String(entry.when ?? '').includes('view == weft.refs') &&
      String(entry.group ?? '').startsWith('navigation'),
  );

  console.log('refs title bar :', icons.length, 'icons |', icons.map((e) => e.command).join(', '));

  if (icons.length > 5) {
    problems.push(`the refs title bar has grown to ${icons.length} unlabelled icons`);
  }
}

for (const expected of contributed) {
  if (!commands.has(expected)) {
    problems.push(`contributed but never registered: ${expected}`);
  }
}

/*
 * The same staleness the other way round. A tree view created in code but contributed to no
 * container has nowhere to appear, and since Weft gave up its own Activity Bar container there is
 * no second home to fall back to - it would simply never be seen, silently.
 */
const scmViews = (manifest.contributes.views?.scm ?? []).map((view) => view.id);

console.log('scm views      :', scmViews.join(', ') || 'NONE');

for (const id of treeViews.keys()) {
  if (!scmViews.includes(id)) {
    problems.push(`tree view is not contributed to Source Control: ${id}`);
  }
}

const progressBefore = progressTitles.length;

await commands.get('weft.openGraph')();

if (panelCreated === null) {
  problems.push('weft.openGraph did not create a webview panel');
} else {
  console.log('panel          :', panelCreated.viewType, '/', panelCreated.title);

  /*
   * The webview has to survive being hidden.
   *
   * Without this VS Code tears it down on every tab switch, the script asks for the history again
   * on the way back, and the reader waits out a whole reload - 2.3 seconds on a 78,000-commit
   * repository - to return to a graph they were already looking at, with the scroll position and
   * the selection gone.
   */
  console.log('  kept alive   :', panelCreated.options?.retainContextWhenHidden === true);

  if (panelCreated.options?.retainContextWhenHidden !== true) {
    problems.push('the graph is thrown away when its tab is hidden, so coming back re-walks');
  }
}

/*
 * And it said so while it worked.
 *
 * Between the click and the tab there is discovery and a ref list. The graph's own progress bar
 * cannot cover that - it lives in the webview, and the webview is the thing being waited for - so
 * the only thing on screen is whatever this command puts there. Half a second of nothing looks
 * exactly like a button that did not work.
 */
const opening = progressTitles.slice(progressBefore).filter((title) => typeof title === 'string');

console.log('while opening  :', opening.join(' | ') || '(silence)');

if (opening.length === 0) {
  problems.push('opening the graph reported nothing while it worked');
}

// The webview announces itself once its script loads; that is what starts the history walk.
if (messageHandler === null) {
  problems.push('panel never subscribed to webview messages');
} else {
  messageHandler({ type: 'ready', search: null, dates: null, firstParent: false });

  // The panel deliberately does not await its own message handler - VS Code's event emitter has
  // nowhere to put the promise - so poll for the terminal message rather than awaiting the call.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !posted.some((m) => m.type === 'done' || m.type === 'error')) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Selecting a commit is the other half of the product: details, file list, and a diff to open.
const firstPage = posted.find((m) => m.type === 'page');
const sampleSha = firstPage?.rows?.[0]?.sha;

if (sampleSha === undefined) {
  problems.push('no commit available to select');
} else {
  messageHandler({ type: 'selectCommit', sha: sampleSha });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !posted.some((m) => m.type === 'details')) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const details = posted.find((m) => m.type === 'details')?.details;

  if (details === undefined) {
    problems.push('selecting a commit produced no details');
  } else {
    console.log('details        :', details.sha.slice(0, 8));
    console.log('  message      :', JSON.stringify(details.body.split('\n')[0]?.slice(0, 60)));

    if (details.body.length === 0) {
      problems.push('commit message came back empty');
    }

    // The files go to Source Control instead. Sending them here as well would be paying twice.
    if ('files' in details) {
      problems.push('the details message still carries the file list');
    }
  }
}

/*
 * The changed files reach the user through the Commit Files section now, so that is where they get
 * checked: its provider is the only thing standing between a `git show` and the sidebar.
 */
const filesProvider = treeProviders.get('weft.files');
const filesView = treeViews.get('weft.files');
const fileNodes = [];

if (filesProvider === undefined) {
  problems.push('no tree provider was registered for weft.files');
} else {
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind === 'file') {
        fileNodes.push(node);
      } else {
        walk(filesProvider.getChildren(node));
      }
    }
  };

  walk(filesProvider.getChildren());

  console.log('commit files   :', fileNodes.length, '|', filesView?.description ?? 'NO DESCRIPTION');

  for (const node of fileNodes.slice(0, 3)) {
    const item = filesProvider.getTreeItem(node);
    console.log(`  ${node.file.status} ${item.label}${item.description === undefined ? '' : ` (${item.description})`}`);
  }

  if (fileNodes.length === 0) {
    problems.push('the commit files section is empty for a commit that changed files');
  }

  if (fileNodes.some((n) => n.file.newBlob === null && n.file.status !== 'D')) {
    problems.push('a non-deleted file has no blob to diff against');
  }

  // Flat reaches the same files by another route; a mode that loses rows is a bug either way.
  await commands.get('weft.filesAsList')();
  const flat = filesProvider.getChildren();
  await commands.get('weft.filesAsTree')();

  if (flat.length !== fileNodes.length) {
    problems.push(`flat view shows ${flat.length} files, tree view ${fileNodes.length}`);
  }
}

// Opening a diff has to survive the whole chain: raw record -> blob OID -> URI -> content provider.
const firstFile = fileNodes[0];

if (firstFile !== undefined) {
  await commands.get('weft.openCommitFile')(firstFile);

  const opened = diffsOpened[0];

  if (opened === undefined) {
    problems.push('opening a file produced no diff');
  } else {
    const provider = contentProviders.get('weft-git');
    console.log('diff           :', opened.title);
    console.log('  right uri    :', opened.right.path);

    if (provider === undefined) {
      problems.push('no content provider was registered for weft-git');
    } else {
      const text = await provider.provideTextDocumentContent(opened.right);
      const left = await provider.provideTextDocumentContent(opened.left);
      console.log('  content      :', text.length, 'chars (was', left.length + ')');

      if (text.length === 0 && firstFile.file.newBlob !== null) {
        problems.push('the diff resolved to empty content for a file that exists');
      }
    }

    if (!/\.[A-Za-z0-9]+$/.test(opened.right.path)) {
      problems.push(`diff URI has no file extension, so VS Code cannot pick a language: ${opened.right.path}`);
    }
  }
}

const kinds = posted.reduce((acc, m) => ({ ...acc, [m.type]: (acc[m.type] ?? 0) + 1 }), {});
const done = posted.find((m) => m.type === 'done');
const rows = posted.filter((m) => m.type === 'page').reduce((n, m) => n + m.rows.length, 0);

console.log('posted         :', JSON.stringify(kinds));
console.log('rows delivered :', rows);
console.log('done           :', done ? `${done.total} commits in ${done.elapsedMs}ms` : 'MISSING');

for (const m of posted) {
  if (m.type === 'error') {
    problems.push(`extension reported an error: ${m.message}`);
  }
}

if (rows === 0) {
  problems.push('no rows were delivered to the webview');
}

if (done === undefined) {
  problems.push('the load never completed');
}

// Search has to actually narrow the result, and an impossible query has to come back empty rather
// than silently falling back to the full history.
{
  const baseline = done?.total ?? 0;

  const runSearch = async (search) => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'search', search });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const dones = posted.filter((m) => m.type === 'done');
      if (dones.length > from) {
        return dones[dones.length - 1].total;
      }

      await new Promise((r) => setTimeout(r, 25));
    }

    return null;
  };

  const plain = { regex: false, caseSensitive: false, allTerms: false, invert: false, follow: false };
  const impossible = await runSearch({ query: 'zzz-no-such-commit-zzz', mode: 'message', ...plain });
  console.log('search (miss)  :', impossible, 'of', baseline);

  if (impossible !== 0) {
    problems.push(`a query matching nothing returned ${impossible} commits`);
  }

  const cleared = await runSearch(null);
  console.log('search cleared :', cleared, 'of', baseline);

  /*
   * The date filter, end to end. The fixture was committed a moment ago, so a window that ends
   * yesterday must be empty and one that starts today must hold everything - and the arguments in
   * between have to survive `--since-as-filter` on a new git and `--since` on an old one.
   */
  const runDates = async (range) => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'dates', range });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const dones = posted.filter((m) => m.type === 'done');
      if (dones.length > from) {
        return dones[dones.length - 1].total;
      }

      await new Promise((r) => setTimeout(r, 25));
    }

    return null;
  };

  const dayOf = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const todayOnly = await runDates({ since: dayOf(0), until: null });
  const beforeToday = await runDates({ since: null, until: dayOf(-1) });
  const noRange = await runDates(null);

  console.log('dates today    :', todayOnly, '| ended yesterday:', beforeToday, '| cleared:', noRange, '| of', baseline);

  if (todayOnly !== baseline) {
    problems.push(`a range starting today lost ${baseline - todayOnly} of ${baseline} commits made today`);
  }

  if (beforeToday !== 0) {
    problems.push(`a range ending yesterday returned ${beforeToday} commits made today`);
  }

  if (noRange !== baseline) {
    problems.push(`clearing the date range left ${noRange} of ${baseline} commits`);
  }

  if (cleared !== baseline) {
    problems.push(`clearing the search gave ${cleared} commits, expected ${baseline}`);
  }
}

/*
 * Right-click. The menu is built by the host from repository state, so this exercises the round
 * trip and the availability rules, not merely that something appears.
 */
{
  const ask = async (label) => {
    const before = posted.filter((m) => m.type === 'menu').length;

    messageHandler({
      type: 'requestMenu',
      target: { kind: 'ref', refName: `refs/heads/${label}`, label, refKind: 'local' },
      x: 10,
      y: 10,
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'menu').length === before) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const menus = posted.filter((m) => m.type === 'menu');
    return menus[menus.length - 1];
  };

  const onSide = await ask('side');
  const onCurrent = await ask('main');

  console.log('\nmenu (side)    :', JSON.stringify(onSide?.items));
  console.log('menu (current) :', JSON.stringify(onCurrent?.items?.map((i) => i.disabledReason)));

  if (onSide?.items?.[0]?.id !== 'weft.checkoutBranch') {
    problems.push('right-clicking a branch did not offer checkout');
  }

  if (onSide?.items?.[0]?.disabledReason !== null) {
    problems.push(`checkout was unavailable on another branch: ${onSide?.items?.[0]?.disabledReason}`);
  }

  if (onCurrent?.items?.[0]?.disabledReason !== 'Already checked out') {
    problems.push('checkout was offered for the branch that is already checked out');
  }

  // The interactive rebase, which is offered onto another branch and refused onto the one you are on.
  const interactive = (menu) => menu?.items?.find((item) => item.id === 'weft.rebaseInteractive');

  console.log(
    'interactive    :',
    JSON.stringify(interactive(onSide)?.label ?? '(not offered)'),
    '| on the current branch:',
    JSON.stringify(interactive(onCurrent)?.disabledReason ?? null),
  );

  if (!/interactively/.test(interactive(onSide)?.label ?? '') || interactive(onSide)?.disabledReason !== null) {
    problems.push(`an interactive rebase onto another branch was ${JSON.stringify(interactive(onSide) ?? null)}`);
  }

  if (interactive(onCurrent)?.disabledReason !== 'Already on this branch') {
    problems.push(`an interactive rebase onto the branch you are on said ${JSON.stringify(interactive(onCurrent)?.disabledReason)}`);
  }
}

/*
 * Ref filtering has to be a real filter, not a display trick: unticking refs must narrow what
 * `git log` walks, so the commit count actually drops.
 */
const treeProvider = treeProviders.get('weft.refs');
const checkboxHandler = checkboxHandlers.get('weft.refs');
const treeView = treeViews.get('weft.refs');

if (treeProvider !== undefined && checkboxHandler !== undefined) {
  const groups = treeProvider.getChildren();
  const allRefs = groups.flatMap((g) => treeProvider.getChildren(g));

  console.log(
    '\nrefs sidebar   :',
    groups.map((g) => `${g.label} (${treeProvider.getChildren(g).length})`).join(', '),
  );
  console.log('  message      :', JSON.stringify(treeView?.message));
  console.log(
    '  collapsed    :',
    groups.every((g) => treeProvider.getTreeItem(g).collapsibleState === 1),
  );

  if (!groups.every((g) => treeProvider.getTreeItem(g).collapsibleState === 1)) {
    problems.push('ref groups are not collapsed by default');
  }

  if (typeof treeView?.message !== 'string' || treeView.message.length === 0) {
    problems.push('the refs view never explains what its checkboxes do');
  }

  /*
   * A graph opens on the branch HEAD is on and nothing else, so the first walk is not the whole
   * history. That is asserted here, and then undone: everything below is about ticks narrowing a
   * full history, and it needs a full one to narrow.
   */
  const openedTicked = allRefs.filter((r) => treeProvider.getTreeItem(r).checkboxState === 1);

  console.log('opens ticked   :', openedTicked.map((r) => r.label).join(', ') || '(nothing)');

  /*
   * How long since each ref moved, beside its name. The whole point of it is deciding not to check
   * out a branch nobody has touched since March, so a row without it is a row that cannot be read
   * for that - and it costs nothing, being one more field on the walk of the refs that already
   * happens.
   */
  const ages = allRefs.map((ref) => String(treeProvider.getTreeItem(ref).description ?? ''));

  console.log('ref ages       :', JSON.stringify(ages));

  if (ages.some((age) => !/ago|just now/.test(age))) {
    problems.push(`a ref was listed with no age beside it: ${JSON.stringify(ages)}`);
  }

  if (openedTicked.length !== 1 || openedTicked[0]?.refName !== 'refs/heads/main') {
    problems.push(
      `a graph should open on the branch HEAD is on; ticked instead: ${openedTicked.map((r) => r.label).join(', ') || 'nothing'}`,
    );
  }

  const widenedFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();

  const baseline = await settle(widenedFrom);

  console.log('opened with    :', done?.total, 'commits; every ref ->', baseline);

  if (baseline <= (done?.total ?? 0)) {
    problems.push('showing every ref did not widen the walk past the branch HEAD is on');
  }

  const keep = allRefs.find((r) => r.label === 'main' || r.label === 'master') ?? allRefs[0];

  if (keep === undefined) {
    problems.push('the refs sidebar listed nothing');
  } else {
    const before = posted.filter((m) => m.type === 'done').length;
    checkboxHandler({ items: allRefs.filter((r) => r !== keep).map((r) => [r, 0]) });

    const deadline = Date.now() + 20_000;
    let narrowed = null;

    while (Date.now() < deadline) {
      const dones = posted.filter((m) => m.type === 'done');
      if (dones.length > before) {
        narrowed = dones[dones.length - 1];
        break;
      }

      await new Promise((r) => setTimeout(r, 25));
    }

    if (narrowed === null) {
      problems.push('unticking refs did not reload the graph');
    } else {
      console.log(`kept only      : ${keep.label}`);
      console.log(`commits        : ${baseline} -> ${narrowed.total}`);
      console.log('  message now  :', JSON.stringify(treeView?.message));

      // Once the user has found the gesture, the line should report rather than keep instructing.
      if (treeView?.message?.includes('Untick') === true) {
        problems.push('the refs view still explains the gesture after it has been used');
      }

      if (narrowed.total >= baseline) {
        problems.push(`filtering to one ref did not narrow the walk (${narrowed.total} of ${baseline})`);
      }

      // And putting them back must restore the full history.
      const beforeRestore = posted.filter((m) => m.type === 'done').length;
      await commands.get('weft.showAllRefs')();

      const restoreDeadline = Date.now() + 20_000;
      let restored = null;

      while (Date.now() < restoreDeadline) {
        const dones = posted.filter((m) => m.type === 'done');
        if (dones.length > beforeRestore) {
          restored = dones[dones.length - 1];
          break;
        }

        await new Promise((r) => setTimeout(r, 25));
      }

      console.log(`show all       : ${restored === null ? 'NO RELOAD' : restored.total}`);

      if (restored === null || restored.total !== baseline) {
        problems.push('Show All Branches & Tags did not restore the full history');
      }
    }
  }
} else {
  problems.push('no refs tree view was registered');
}

/*
 * The three presets, driven from the graph rather than from the sidebar.
 *
 * The buttons are in the webview and the state they move is the sidebar's, so this is the whole
 * round trip: a message from the view, a provider that changes, and a graph that reloads. The
 * counts are the point - "nothing ticked" has to reach git as a walk of nothing, not as a walk of
 * everything with the ticks ignored.
 */
{
  const refsProvider = treeProviders.get('weft.refs');

  if (refsProvider === undefined) {
    problems.push('no refs tree view to drive the presets against');
  } else {
    const tickedNow = () =>
      refsProvider
        .getChildren()
        .flatMap((g) => refsProvider.getChildren(g))
        .filter((ref) => refsProvider.getTreeItem(ref).checkboxState === 1);

    /*
     * A preset that asks for the state the graph is already in moves no tick and walks nothing -
     * which is what "everything" does here, the section above having just put every ref back. So the
     * ticks say whether there is a walk to wait for: where they moved, the count comes from the walk
     * that follows; where they did not, it comes from the walk already drawn.
     */
    const send = async (preset) => {
      const from = posted.filter((m) => m.type === 'done').length;
      const ticked = tickedNow().length;

      await messageHandler({ type: 'refsPreset', preset });
      await until(() => tickedNow().length !== ticked, SETTLING);

      return tickedNow().length === ticked
        ? posted.filter((m) => m.type === 'done').pop()?.total ?? -1
        : settle(from);
    };

    const all = await send('all');
    const everyRef = tickedNow().length;

    const none = await send('none');
    const noRef = tickedNow().length;

    const current = await send('current');
    const currentRefs = tickedNow().map((ref) => ref.label);

    console.log('');
    console.log('presets        : all ->', all, 'commits,', everyRef, 'ticked');
    console.log('                 none ->', none, 'commits,', noRef, 'ticked');
    console.log('                 current ->', current, 'commits,', currentRefs.join(', '));

    if (everyRef === 0 || all <= 0) {
      problems.push(`the "everything" preset left ${everyRef} refs ticked and ${all} commits`);
    }

    if (noRef !== 0 || none !== 0) {
      problems.push(`the "nothing" preset left ${noRef} refs ticked and ${none} commits`);
    }

    if (currentRefs.length !== 1 || currentRefs[0] !== 'main') {
      problems.push(
        `the "current branch" preset ticked ${currentRefs.join(', ') || 'nothing'}, expected main`,
      );
    }

    if (current >= all) {
      problems.push(`the "current branch" preset walked ${current} of ${all} commits`);
    }
  }
}

/*
 * Listing only what is ticked.
 *
 * A listing filter, not a walk filter: it decides who is on screen to untick, and the graph is
 * untouched by it. The counts beside a group have to keep saying "1 of 148" while it is on, or the
 * one number that says how much is being hidden becomes "1 of 1".
 */
{
  const refsProvider = treeProviders.get('weft.refs');

  if (refsProvider === undefined) {
    problems.push('no refs tree view to list the ticked ones from');
  } else {
    const everyRef = () => refsProvider.getChildren().flatMap((g) => refsProvider.getChildren(g));

    // From the default, which is the branch HEAD is on and nothing else. Whatever walk that sets off
    // has to have landed before the count below is taken, or the walk this section insists did not
    // happen is that one - and it sets off none at all when the graph is already showing just that.
    const narrowedFrom = posted.filter((m) => m.type === 'done').length;
    await commands.get('weft.showCurrentRefOnly')();
    await settle(narrowedFrom, SETTLING);

    const before = everyRef().length;
    const walkBefore = posted.filter((m) => m.type === 'done').length;

    await commands.get('weft.listTickedRefs')();

    const listed = everyRef();
    const groups = refsProvider.getChildren();
    const counts = groups.map((group) => refsProvider.getTreeItem(group).description);

    console.log('');
    console.log('ticked only    :', listed.map((r) => r.label).join(', ') || '(nothing)');
    console.log('group counts   :', JSON.stringify(counts), '| listed', before, '->', listed.length);

    if (listed.length >= before) {
      problems.push(`listing only the ticked left ${listed.length} of ${before} refs listed`);
    }

    if (listed.some((ref) => refsProvider.getTreeItem(ref).checkboxState !== 1)) {
      problems.push('listing only the ticked left an unticked ref on screen');
    }

    // A listing is not a walk: nothing about what git was asked for has changed.
    if (posted.filter((m) => m.type === 'done').length !== walkBefore) {
      problems.push('listing only the ticked re-walked the history, which is not what it decides');
    }

    if (counts.some((description) => String(description).endsWith('/1'))) {
      problems.push(`the group counts collapsed to their own listing: ${JSON.stringify(counts)}`);
    }

    await commands.get('weft.listAllRefs')();

    const back = everyRef().length;
    console.log('listing all    :', back, 'refs');

    if (back !== before) {
      problems.push(`listing every ref again gave ${back} of the ${before} there were`);
    }
  }
}

/*
 * Ordering the list. Neither order changes a tick or a walk - this is about finding a name among a
 * hundred and fifty, and about seeing which of them anybody is still working on.
 */
{
  const refsProvider = treeProviders.get('weft.refs');

  if (refsProvider === undefined) {
    problems.push('no refs tree view to sort');
  } else {
    const inGroups = () =>
      refsProvider.getChildren().map((group) => refsProvider.getChildren(group));

    /*
     * A branch that moved a year ago, because every ref in this fixture was made within the same
     * second and an order over identical timestamps is any order at all - the assertion below
     * would hold whether the sort ran or not.
     */
    runGit(repoPath, 'branch', '-f', 'ancient', 'HEAD');
    runGit(repoPath, 'checkout', '-q', 'ancient');
    writeFileSync(join(repoPath, 'ancient.txt'), 'a year ago\n');
    runGit(repoPath, 'add', '-A');
    runGitAt(repoPath, '2025-01-02T03:04:05', 'commit', '-q', '-m', 'from a year ago');
    runGit(repoPath, 'checkout', '-q', 'main');

    // The provider's own read: `weft.refresh` reloads the graph, and a ref that appeared since the
    // view last looked is a different question.
    await refsProvider.reload();

    await commands.get('weft.sortRefsByRecent')();

    const recent = inGroups();

    console.log('');
    console.log('sorted recent  :', JSON.stringify(recent.flat().map((ref) => ref.label)));

    // Non-increasing rather than a fixed order: a fixture built in one second has ties in it, and
    // a test that depends on how they fall is a test that fails on a faster machine.
    // Within its own group: the tree is grouped first and sorted inside each, so a tag being last
    // overall says nothing about where a year-old branch ended up among the branches.
    const locals = recent.find((group) => group.some((ref) => ref.label === 'ancient'));

    if (locals === undefined) {
      problems.push('the year-old branch was not listed at all');
    } else if (locals[locals.length - 1]?.label !== 'ancient') {
      problems.push(
        `sorting by most recent did not sink the year-old branch: ${JSON.stringify(locals.map((r) => r.label))}`,
      );
    }

    for (const group of recent) {
      const ages = group.map((ref) => ref.updated);

      if (ages.some((age, i) => i > 0 && age > ages[i - 1])) {
        problems.push(`sorting by most recent left an older ref above a newer one: ${JSON.stringify(group.map((r) => r.label))}`);
        break;
      }
    }

    await commands.get('weft.sortRefsByName')();

    const named = inGroups();

    console.log('sorted by name :', JSON.stringify(named.flat().map((ref) => ref.label)));

    for (const group of named) {
      const labels = group.map((ref) => ref.label);

      if (labels.some((label, i) => i > 0 && label < labels[i - 1])) {
        problems.push(`sorting by name left a ref out of order: ${JSON.stringify(labels)}`);
        break;
      }
    }

    /*
     * And the list the header's branch menu is sent, which has to be in the same order.
     *
     * It was not: the menu was handed the refs in the order git listed them whatever the sidebar
     * was set to, so switching the tree to "most recent" left the menu alphabetical.
     */
    const menuOrder = () => refsProvider.listForMenu().map((ref) => ref.label);

    await commands.get('weft.sortRefsByRecent')();
    const menuRecent = menuOrder();

    await commands.get('weft.sortRefsByName')();
    const menuNamed = menuOrder();

    console.log('menu recent    :', JSON.stringify(menuRecent));
    console.log('menu by name   :', JSON.stringify(menuNamed));

    if (menuRecent.join() === menuNamed.join()) {
      problems.push('the branch menu was sent the same order for both settings, so it follows neither');
    }

    /*
     * Compared against the tree's own listing rather than re-derived, because a check that works
     * out the right answer twice agrees with itself and not with the thing it is checking.
     *
     * Per group, because that is how both are shown: the tree sorts inside Local / Remote / Tags,
     * and the menu sorts the whole list and then splits it by kind. Flat, the two disagree the
     * moment a tag sorts between two branches, and the rendered lists are the same.
     */
    for (const order of ['weft.sortRefsByRecent', 'weft.sortRefsByName']) {
      await commands.get(order)();

      const kinds = { 'Local Branches': 'local', 'Remote Branches': 'remote', Tags: 'tag' };
      const menu = refsProvider.listForMenu();

      for (const group of refsProvider.getChildren()) {
        const kind = kinds[group.label];
        const tree = refsProvider.getChildren(group).map((ref) => ref.label);
        const listed = menu.filter((ref) => ref.kind === kind).map((ref) => ref.label);

        if (listed.join() !== tree.join()) {
          problems.push(
            `under ${order}, ${group.label} reads differently in the menu than in the tree: ` +
              `menu ${JSON.stringify(listed)}, tree ${JSON.stringify(tree)}`,
          );
        }
      }
    }

    runGit(repoPath, 'branch', '-D', 'ancient');
    await refsProvider.reload();
  }
}

/*
 * Show File History, from a file rather than from the tree.
 *
 * The tree's version could assume both halves of the answer, because its files came out of a commit
 * Weft had already walked. A file picked in the Explorer arrives as a Uri and knows neither which
 * repository it is under nor what git calls it - and getting the second wrong is the failure that
 * looks like success: git accepts an absolute path and walks a file it has never heard of, which is
 * an empty graph and no error.
 */
{
  const before = posted.filter((m) => m.type === 'showHistory').length;

  await commands.get('weft.showFileHistory')(uri(`${repoPath}/f1.txt`));
  await until(() => posted.filter((m) => m.type === 'showHistory').length > before);

  const asked = posted.filter((m) => m.type === 'showHistory');
  const path = asked[asked.length - 1]?.path;

  console.log('');
  console.log('file history   :', asked.length > before ? JSON.stringify(path) : 'NOTHING ASKED');

  if (asked.length === before) {
    problems.push('Show File History on a file from the Explorer asked the graph for nothing');
  } else if (path !== 'f1.txt') {
    problems.push(`Show File History asked for "${path}", which is not what git calls that file`);
  }
}

/*
 * Checking out asks first, however it was asked for.
 *
 * It did not always. The reasoning was that reaching Checkout in a menu is already two deliberate
 * steps, and that a dialog on top of them is a click which teaches people to click through
 * dialogs - so only the switch box, a text field with Return bound to "check that branch out",
 * asked. That left the same action asking or not depending on which control you reached for, and
 * the control that asked was not the one people reached for by accident: the branch dropdown
 * checked out from a click on a name, next to a tick that only filtered.
 *
 * So the answer belongs to the action rather than to the caller - `movesHead` on the action. It was
 * then read where the graph's messages arrive, and 0.8.0 said checking out always asked while the
 * sidebar's Checkout, which calls the action directly, never did - and a commit was waved through as
 * something picked by pointing. It is read in `runAction` now, where every way in passes, and all
 * three are driven here: the graph's message, the sidebar's command, and a detached checkout. Each
 * must ask exactly once - twice is the question asked in two places, which is how this started.
 */
{
  const head = () => String(runGit(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const side = { kind: 'ref', refName: 'refs/heads/side', label: 'side', refKind: 'local' };

  const before = confirmations.length;

  // Said no.
  confirmed = false;
  await messageHandler({ type: 'runAction', id: 'weft.checkoutBranch', target: side });
  await until(() => confirmations.length > before);
  // And then a moment with no second question, because "asked once" is half a statement about a
  // question that was never asked twice, and only time can say that one.
  await quiet();

  const asked = confirmations.slice(before);

  console.log('');
  console.log(
    'switch asks    :',
    asked.length === 0
      ? 'NOTHING ASKED'
      : JSON.stringify(`${asked[0].message} — ${asked[0].detail}`),
  );
  console.log('  said no      : HEAD is', head());

  if (asked.length !== 1) {
    problems.push(`checking out asked ${asked.length} times, not once`);
  } else {
    if (!String(asked[0].message).includes('side')) {
      problems.push(`the switch dialog did not name the branch: ${asked[0].message}`);
    }

    if (!/ago|just now/.test(String(asked[0].detail))) {
      problems.push(`the switch dialog did not say how old the branch is: ${asked[0].detail}`);
    }
  }

  if (head() !== 'main') {
    problems.push('saying no to the switch dialog checked the branch out anyway');
  }

  /*
   * And the right-click menu, which is the same message from a different control - the one that
   * used to arrive with no flag on it and run straight through.
   */
  confirmed = true;
  const beforeMenu = confirmations.length;
  const saidBefore = statusMessages.length;

  await messageHandler({ type: 'runAction', id: 'weft.checkoutBranch', target: side });

  /*
   * Until the checkout has moved HEAD and said so, rather than for a fixed two and a half seconds - which is
   * still the least it waits, for the steps after this one. The status line is set once the action has
   * returned, after HEAD moves, and under the load of a whole test run it came later than that: HEAD was on
   * side and the line had not been said.
   */
  const waited = Date.now();

  while (
    Date.now() - waited < 15_000 &&
    (Date.now() - waited < 2500 || statusMessages.length === saidBefore || head() !== 'side')
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('  menu path    : HEAD is', head(), '| asked', confirmations.length - beforeMenu, 'times');

  // A checkout does move HEAD, so it keeps its way back.
  if (!/\(was [0-9a-f]{8}\)/.test(statusMessages.at(-1) ?? '')) {
    problems.push(`a checkout that moved HEAD did not say where it was: ${statusMessages.at(-1)}`);
  }

  if (confirmations.length - beforeMenu !== 1) {
    problems.push(`checking out from a menu asked ${confirmations.length - beforeMenu} times, not once`);
  }

  if (head() !== 'side') {
    problems.push('saying yes to the menu dialog did not check the branch out');
  }

  const backToMain = async () => {
    confirmed = true;
    const said = statusMessages.length;
    await messageHandler({
      type: 'runAction',
      id: 'weft.checkoutBranch',
      target: { kind: 'ref', refName: 'refs/heads/main', label: 'main', refKind: 'local' },
    });

    // The status line is said once the action has returned, which is after HEAD has moved - so a new
    // one is the checkout being over, and it is the later of the two things to wait for.
    if (!(await until(() => statusMessages.length > said))) {
      problems.push('going back to main never finished: no status line was said for the checkout');
    }
  };

  await backToMain();

  /*
   * The sidebar's Checkout, which calls the action directly rather than sending a message - the way
   * in that 0.8.0 said asked, and did not.
   */
  const refsTree = treeProviders.get('weft.refs');
  const sideNode = refsTree
    ?.getChildren()
    .flatMap((group) => refsTree.getChildren(group))
    .find((node) => refsTree.targetOf(node)?.refName === 'refs/heads/side');

  if (sideNode === undefined) {
    problems.push('no row for side in Branches & Tags to check out from');
  } else {
    confirmed = false;
    const beforeNo = confirmations.length;
    await commands.get('weft.checkoutRef')(sideNode);
    await until(() => confirmations.length > beforeNo);
    // Then a moment of silence, which is the other half of both statements here: that the question
    // was not asked twice, and that saying no did not check the branch out anyway.
    await quiet();
    const askedNo = confirmations.length - beforeNo;
    const afterNo = head();

    confirmed = true;
    const beforeYes = confirmations.length;
    const saidYes = statusMessages.length;
    await commands.get('weft.checkoutRef')(sideNode);
    await until(() => confirmations.length > beforeYes && statusMessages.length > saidYes);
    await quiet();
    const askedYes = confirmations.length - beforeYes;

    console.log('  sidebar      : asked', askedNo, 'then', askedYes, '| HEAD after no:', afterNo, 'after yes:', head());

    if (askedNo !== 1 || askedYes !== 1) {
      problems.push(`checking out from Branches & Tags asked ${askedNo} and ${askedYes} times, not once each`);
    }

    if (afterNo !== 'main') {
      problems.push('saying no to the sidebar checkout checked the branch out anyway');
    }

    if (head() !== 'side') {
      problems.push('saying yes to the sidebar checkout did not check the branch out');
    }

    await backToMain();
  }

  // And a commit, which detaches HEAD - once waved through as something picked by pointing.
  const detachAt = String(runGit(repoPath, 'rev-parse', 'main~1')).trim();
  const detachSubject = String(runGit(repoPath, 'log', '-1', '--format=%s', detachAt)).trim();

  confirmed = false;
  const beforeCommit = confirmations.length;
  await messageHandler({
    type: 'runAction',
    id: 'weft.checkoutCommit',
    target: { kind: 'commit', sha: detachAt, subject: detachSubject },
  });
  await until(() => confirmations.length > beforeCommit);
  // And a moment with nothing more, for the two things absence says here: asked once, and HEAD left
  // where it was.
  await quiet();
  const commitAsked = confirmations.slice(beforeCommit);

  console.log(
    '  detached     :',
    commitAsked.length === 0
      ? 'NOTHING ASKED'
      : JSON.stringify(`${commitAsked[0].message} — ${String(commitAsked[0].detail).split('\n').join(' / ')}`),
  );

  if (commitAsked.length !== 1) {
    problems.push(`checking out a commit asked ${commitAsked.length} times, not once`);
  } else if (
    !String(commitAsked[0].message).includes(detachAt.slice(0, 8)) ||
    !/detached/i.test(`${commitAsked[0].message} ${commitAsked[0].detail}`)
  ) {
    problems.push(`the detached checkout did not name the commit, or did not say HEAD would be detached: ${commitAsked[0].message}`);
  }

  if (head() !== 'main') {
    problems.push('saying no to a detached checkout moved HEAD anyway');
    await backToMain();
  }

  confirmed = true;
}

/*
 * Backing out of an action's own question walks nothing.
 *
 * Dismissing the name box for a new branch was read as the action having run: the history was walked
 * again from the top to draw what was already on screen, and the status bar said "Weft:" with nothing
 * after it but "(was …)".
 */
{
  const at = String(runGit(repoPath, 'rev-parse', 'main')).trim();
  const postedBefore = posted.length;
  const statusBefore = statusMessages.length;

  inputAnswers.length = 0;
  await messageHandler({ type: 'runAction', id: 'weft.createBranch', target: { kind: 'commit', sha: at, subject: 'main' } });
  // Nothing to wait for by name: what is being asserted is that the walk which used to follow a
  // dismissed name box does not, and a walk that never starts posts nothing to poll for.
  await quiet();

  const walked = posted.slice(postedBefore).filter((m) => m.type === 'reset' || m.type === 'done').length;
  const said = statusMessages.slice(statusBefore);

  console.log('');
  console.log('backed out     :', walked === 0 ? 'nothing walked' : `${walked} reset/done posted`, '| status', JSON.stringify(said));

  if (walked > 0) {
    problems.push("dismissing a new branch's name box walked the history again");
  }

  if (said.some((m) => /^Weft:\s*(\(|$)/.test(m))) {
    problems.push(`backing out left a status line with nothing to say: ${JSON.stringify(said)}`);
  }
}

/*
 * A checkout takes the ticks with it.
 *
 * The default is "the branch you are on", and which branch that is changes. Switching has to move
 * the ticks even when the set on screen is one somebody chose by hand - a graph still drawing the
 * branch you left is drawing the wrong thing, and finding the new one by hand means a search
 * through every ref in the repository. Show All immediately before this is what makes this the
 * interesting case rather than a no-op.
 */
{
  const refsProvider = treeProviders.get('weft.refs');

  if (refsProvider === undefined) {
    problems.push('no refs tree view to check a checkout against');
  } else {
    const everyRef = () => refsProvider.getChildren().flatMap((g) => refsProvider.getChildren(g));
    const tickedNow = () =>
      everyRef().filter((ref) => refsProvider.getTreeItem(ref).checkboxState === 1);

    const shownFrom = posted.filter((m) => m.type === 'done').length;
    await commands.get('weft.showAllRefs')();
    await settle(shownFrom, SETTLING);

    const chosen = tickedNow().length;

    /*
     * Until the ticks are the one branch, for as long as fifteen seconds - not a fixed wait. Asking,
     * checking out, telling the sidebar and its read of the refs are a handful of git processes, and on
     * a busy machine two and a half seconds was once not enough for all of them: the ticks still read as
     * they were before the checkout, and a checkout that moves them was reported as one that does not.
     */
    const ticksAre = async (refName) => {
      const started = Date.now();

      while (Date.now() - started < 15_000) {
        const now = tickedNow();

        if (now.length === 1 && now[0]?.refName === refName) {
          break;
        }

        await new Promise((r) => setTimeout(r, 100));
      }

      return { ticked: tickedNow(), seconds: ((Date.now() - started) / 1000).toFixed(1) };
    };

    await messageHandler({
      type: 'runAction',
      id: 'weft.checkoutBranch',
      target: { kind: 'ref', refName: 'refs/heads/side', label: 'side', refKind: 'local' },
    });

    const { ticked: after, seconds } = await ticksAre('refs/heads/side');

    console.log('');
    console.log('checkout ticks :', chosen, 'ticked ->', after.map((r) => r.label).join(', ') || '(nothing)', `(${seconds}s)`);

    if (after.length !== 1 || after[0]?.refName !== 'refs/heads/side') {
      problems.push(
        `a checkout should leave only the new branch ticked; ticked: ${after.map((r) => r.label).join(', ') || 'nothing'}`,
      );
    }

    // Back to main, so nothing after this is reading a different branch's history - and waited for the
    // same way, then for the walk the checkout sets off, before the next check reads the sidebar.
    const backFrom = posted.filter((m) => m.type === 'done').length;

    await messageHandler({
      type: 'runAction',
      id: 'weft.checkoutBranch',
      target: { kind: 'ref', refName: 'refs/heads/main', label: 'main', refKind: 'local' },
    });

    await ticksAre('refs/heads/main');
    await settle(backFrom, SETTLING);
  }
}

/*
 * A tick set in the sidebar has to survive the next reload.
 *
 * The two ways to tick a ref were written separately, and only one of them stopped following HEAD.
 * The tree's own checkbox reached into `hidden` directly, so the next `reload` called
 * `applyDefault` and put the ticks back to "the branch you are on" - not immediately, which is why
 * it passed being tested by hand, but on the next fetch, commit, branch deleted, or the graph tab
 * regaining focus. Reloading here is what the bug needed and what a click never does on its own.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const refsHandler = checkboxHandlers.get('weft.refs');

  if (refsProvider === undefined || refsHandler === undefined) {
    problems.push('no refs tree to tick');
  } else {
    const everyRef = () => refsProvider.getChildren().flatMap((g) => refsProvider.getChildren(g));
    const tickedNow = () =>
      everyRef()
        .filter((ref) => refsProvider.getTreeItem(ref).checkboxState === 1)
        .map((ref) => ref.refName)
        .sort();

    const before = tickedNow();
    const victim = everyRef().find((ref) => !before.includes(ref.refName));

    if (victim === undefined) {
      problems.push('every ref is already ticked, so there is nothing to prove');
    } else {
      refsHandler({ items: [[victim, 1]] });

      const ticked = tickedNow();
      await refsProvider.reload();
      const survived = tickedNow();

      console.log('');
      console.log('ticked in tree :', ticked.join(', '));
      console.log('after a reload :', survived.join(', '));

      if (!ticked.includes(victim.refName)) {
        problems.push(`ticking ${victim.label} in the tree did not tick it`);
      }

      if (!survived.includes(victim.refName)) {
        problems.push(
          `${victim.label} was ticked in the tree and the next reload put it back`,
        );
      }

      // And the graph has to agree that something is being filtered, or Clear Filters stays dark.
      /*
       * By the path git spells, not the one `mkdtemp` handed back: on Windows one directory has a
       * short name and a long one, and the provider's root came from `rev-parse --show-toplevel`.
       * The same mismatch that kept working-tree events from arriving at all until 91c7ef5.
       */
      const root = realpathSync.native(repoPath).replace(/\\/g, '/');

      if (!refsProvider.isNarrowed(root)) {
        problems.push('a hand-picked set of refs was not reported as narrowing anything');
      }

      const untickedFrom = posted.filter((m) => m.type === 'done').length;
      refsHandler({ items: [[victim, 0]] });
      await settle(untickedFrom, SETTLING);
    }
  }
}

/*
 * The two sidebar filters. They do different jobs and both are worth proving: the ref filter
 * narrows the *listing*, the author filter narrows what git *walks*.
 */
{
  const before = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length;

  await typeIntoRefFilter('side');
  const filtered = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g));

  console.log(`\nref filter     : ${before} refs -> ${filtered.length} matching "side"`);
  console.log('  message      :', JSON.stringify(treeView?.message));

  if (filtered.length >= before || filtered.length === 0) {
    problems.push(`the ref filter did not narrow the listing (${before} -> ${filtered.length})`);
  }

  if (treeView?.message?.includes('side') !== true) {
    problems.push('the refs view does not say a filter is applied');
  }

  // A group with a match opens itself; matches behind a closed chevron help nobody.
  const groups = treeProvider.getChildren();
  if (!groups.every((g) => treeProvider.getTreeItem(g).collapsibleState === 2)) {
    problems.push('a filtered group did not expand to show its matches');
  }

  await typeIntoRefFilter('');

  if (treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length !== before) {
    problems.push('clearing the ref filter did not restore the listing');
  }

  // The picker offers the ref names, which is the point of it being a picker.
  await commands.get('weft.filterRefs')();
  const offered = quickPick.picker.items.map((item) => item.label);
  console.log('  completions  :', offered.join(', '));

  if (offered.length !== before) {
    problems.push(`the picker offered ${offered.length} refs, expected ${before}`);
  }

  // Picking one filters to exactly it, rather than to whatever was typed.
  quickPick.picker.selectedItems = [quickPick.picker.items.find((i) => i.label === 'side')];
  quickPick.handlers.accept?.();

  if (treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length !== 1) {
    problems.push('picking a ref did not filter to it');
  }

  // Escape has to undo the live filtering, or cancelling would still change something.
  await commands.get('weft.filterRefs')();
  quickPick.handlers.change?.('nothing-matches-this');
  quickPick.handlers.hide?.();

  const afterEscape = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length;
  console.log(`  escape       : back to filtering "side" (${afterEscape} ref)`);

  if (afterEscape !== 1) {
    problems.push(`escaping the picker left the filter changed (${afterEscape} refs listed)`);
  }

  /*
   * "Show all" has to clear the text filter too. It used to clear only the unticked refs, and to
   * return early when nothing was unticked - so with a text filter applied and nothing unticked,
   * which is the ordinary case, the button did nothing at all.
   */
  /*
   * Its premise is "nothing unticked", and a graph opens on the branch HEAD is on - so that is a
   * state to reach first rather than one to assume.
   */
  const everythingFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();
  await settle(everythingFrom, SETTLING);

  await typeIntoRefFilter('side');

  const reloadsBefore = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();

  const restored = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length;
  console.log(`  show all     : back to ${restored} refs`);

  if (restored !== before) {
    problems.push(`Show All left the text filter applied (${restored} of ${before} refs listed)`);
  }

  // And it should not have re-walked the history: no tick changed, so the graph is unaffected. A walk
  // that never starts posts nothing, so the only evidence is a stretch of time with the count still
  // where it was.
  await quiet();

  if (posted.filter((m) => m.type === 'done').length !== reloadsBefore) {
    problems.push('clearing a text-only filter reloaded the graph for nothing');
  }
}

{
  const treeProvider = treeProviders.get('weft.refs');
  const checkboxHandler = checkboxHandlers.get('weft.refs');

  /*
   * A tick has to survive the render that follows it. Weft marks a group as ticked whenever any of
   * its refs are showing, which is not what VS Code means by a ticked parent - so with the
   * checkboxes left in VS Code's hands, unticking one branch was undone before it was seen.
   */
  {
    const groups = treeProvider.getChildren();
    const locals = treeProvider.getChildren(groups.find((g) => g.id === 'heads'));
    const victim = locals.find((ref) => ref.label !== 'main') ?? locals[0];

    checkboxHandler({ items: [[victim, 0]] });
    propagateCheckboxes('weft.refs');

    const stillOff = treeProvider.getTreeItem(victim).checkboxState === 0;

    console.log('  tick sticks  :', victim.label, stillOff ? 'stayed unticked' : 'WAS TICKED BACK ON');

    if (!stillOff) {
      problems.push(`unticking ${victim.label} did not stick: the group's own tick put it back`);
    }

    const restoreFrom = posted.filter((m) => m.type === 'done').length;
    await commands.get('weft.showAllRefs')();
    await settle(restoreFrom, SETTLING);
  }
}

{
  const treeView = treeViews.get('weft.refs');

  // Counted, not written down. These assertions were two hardcoded 2s until a tag was added to the
  // fixture, at which point they failed for saying nothing about the code.
  const total = treeProviders.get('weft.refs').listRefs().length;

  /*
   * The message has to carry the half that is not on screen. Filtering the list leaves every ref
   * that fell out of it still ticked and still walked - so a line naming only what is listed
   * invites the reader to conclude they are looking at the filter itself, which on a repository
   * with two dozen refs is exactly what happened.
   */
  /*
   * `main` rather than `side`: in this fixture `side` is ahead of `main` and reaches every commit,
   * so narrowing to it narrows nothing - a useless thing to assert a commit count against.
   */
  await typeIntoRefFilter('main');
  const narrowed = treeView?.message ?? '';

  console.log('  says         :', JSON.stringify(narrowed));

  if (!narrowed.includes(`of ${total} refs`)) {
    problems.push(`the message does not say how many refs it is listing: ${narrowed}`);
  }

  if (!narrowed.includes(`still walks all ${total}`)) {
    problems.push(`the message does not say the unlisted refs are still walked: ${narrowed}`);
  }

  // And the one click that makes the graph agree with the list.
  const applyFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showOnlyListedRefs')();

  const applyBy = Date.now() + 20_000;
  while (Date.now() < applyBy && posted.filter((m) => m.type === 'done').length === applyFrom) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const applied = posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  // The walk immediately before applying, not the first of the session: the first is the branch
  // HEAD is on, which is narrower than what this is about to narrow.
  const baseline = posted.filter((m) => m.type === 'done')[applyFrom - 1]?.total ?? 0;

  console.log('  applied      :', applied, 'commits from the one ref that was listed');

  if (applied < 0) {
    problems.push('applying the list filter to the graph reloaded nothing');
  }

  if (applied >= baseline && baseline > 0) {
    problems.push(`applying the list filter left ${applied} of ${baseline} commits`);
  }

  const wholeFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();
  await settle(wholeFrom, SETTLING);
}

{
  const authorsProvider = treeProviders.get('weft.authors');
  const authorsHandler = checkboxHandlers.get('weft.authors');

  if (authorsProvider === undefined || authorsHandler === undefined) {
    problems.push('no authors view was registered');
  } else {
    const authors = await authorsProvider.getChildren();
    console.log(
      '\nauthors        :',
      // The tree hands back nodes now, one level of people and one of spellings inside them.
      authors.map((a) => `${a.author.name} (${a.author.commits})`).join(', ') || '(none)',
    );

    if (authors.length === 0) {
      problems.push('the authors view listed nobody');
    } else {
      /*
       * The walk before this one has landed: the block above puts every ref back and waits for the
       * reload it sets off, rather than sleeping over it. Reading the baseline while that reload was
       * still in flight got the narrowed number - against which the author filter appears to have
       * narrowed nothing.
       */
      const baseline = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;
      const from = posted.filter((m) => m.type === 'done').length;

      authorsHandler({ items: [[authors[0], 1]] });

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length === from) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const after = posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
      console.log(`  filtered to  : ${authors[0].author.name} -> ${after} of ${baseline} commits`);

      if (after >= baseline || after !== authors[0].author.commits) {
        problems.push(
          `filtering to ${authors[0].author.name} gave ${after} commits, expected their ${authors[0].author.commits} of ${baseline}`,
        );
      }

      // Put it back. Leaving a filter on would silently change what every later section is
      // measuring - which is exactly what it did the first time this ran.
      await commands.get('weft.showAllAuthors')();

      const restoreDeadline = Date.now() + 20_000;
      while (
        Date.now() < restoreDeadline &&
        (posted.filter((m) => m.type === 'done').pop()?.total ?? 0) !== baseline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
}

/*
 * Narrowing the author list, which is a different job from ticking one.
 *
 * The tick decides whose commits the graph walks; the text decides who is on screen to tick. A
 * repository with two hundred contributors makes the second the thing standing between the reader
 * and the first, and the message has to say which of the two just happened.
 */
{
  const provider = treeProviders.get('weft.authors');
  const view = treeViews.get('weft.authors');
  const everyone = await provider.getChildren();
  const walksBefore = posted.filter((m) => m.type === 'done').length;

  // Drive it the way the picker does: type, then accept.
  const target = everyone[0].author;
  provider.setQuery(target.name);

  const listed = await provider.getChildren();

  console.log('\nauthor filter  :', JSON.stringify(view?.message ?? ''));
  console.log('  listing      :', listed.map((a) => a.author.name).join(', '), `of ${everyone.length}`);

  if (listed.length !== 1 || listed[0].author.name !== target.name) {
    problems.push(`filtering authors to ${target.name} listed ${listed.length}`);
  }

  // Typing a name walks nothing: the graph is whatever the ticks say, and none of them moved.
  if (posted.filter((m) => m.type === 'done').length !== walksBefore) {
    problems.push('narrowing the author list re-walked the history');
  }

  const said = view?.message ?? '';

  if (!said.includes(`of ${everyone.length} authors`)) {
    problems.push(`the message does not say how many authors it is listing: ${said}`);
  }

  // The half that is not on screen. Without it the reader concludes the list is the filter.
  if (!said.includes('still shows everyone')) {
    problems.push(`the message does not say the graph is unaffected: ${said}`);
  }

  // --- and the second half of the gesture: show the graph exactly who is listed -----------------
  await commands.get('weft.showOnlyListedAuthors')();

  const by = Date.now() + 20_000;
  while (Date.now() < by && posted.filter((m) => m.type === 'done').length === walksBefore) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const narrowed = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;

  console.log('  applied      :', narrowed, 'commits |', JSON.stringify(view?.message ?? ''));

  if (narrowed !== target.commits) {
    problems.push(`showing only ${target.name} gave ${narrowed} commits, expected ${target.commits}`);
  }

  // Back to everyone, so nothing after this is measuring a filtered history.
  const everyoneFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllAuthors')();
  await settle(everyoneFrom, SETTLING);

  if (provider.filterText !== '') {
    problems.push('Show All left the author list still narrowed');
  }
}

/*
 * Two levels, and a group made by hand.
 *
 * A person is a group of spellings and the spellings are the rows inside it - except where there is
 * only one, which is a row and not a group of one. The rule folds what it can prove and stops; past
 * that the reader says so, and saying so has to be undoable, because it is a judgement and
 * judgements are wrong sometimes.
 *
 * And a group is a label rather than a box: the same person is on two teams, so they are listed
 * under both, and taking them out of one leaves the other alone.
 */
{
  const provider = treeProviders.get('weft.authors');
  const people = await provider.getChildren();

  console.log('');
  console.log(
    'author tree    :',
    people.map((node) => `${node.author.name}[${node.author.members.length}]`).join(', '),
  );

  if (people.some((node) => node.kind !== 'group')) {
    problems.push('the top of the author list is something other than people');
  }

  const lone = people.find((node) => node.author.members.length === 1);

  if (lone !== undefined && (await provider.getChildren(lone)).length !== 0) {
    problems.push('an author of one spelling was drawn as something to open');
  }

  if (people.length < 2) {
    problems.push('the fixture has too few authors to group');
  } else {
    const [first, second] = people;

    provider.addToGroup(provider.spellingsOf(second), first.author.name);

    const joined = await provider.getChildren();
    const group = joined.find((node) => node.author.name === first.author.name);
    const members = group === undefined ? [] : await provider.getChildren(group);

    console.log(
      'grouped by hand:',
      `${group?.author.name} -> ${members.map((node) => node.identity.name).join(', ')}`,
    );

    if (members.length !== 2) {
      problems.push(`grouping by hand gave ${members.length} spellings, expected two`);
    }

    if (members.some((node) => node.kind !== 'member')) {
      problems.push('a group opened onto something other than its spellings');
    }

    // --- and into a second group, without leaving the first ---------------------------------

    // Everyone in the first group, so that both groups hold the same two spellings and the tree
    // has to draw each of them twice.
    const inBoth = group === undefined ? [] : provider.spellingsOf(group);

    provider.addToGroup(inBoth, 'Release Rota');

    const both = await provider.getChildren();
    const rota = both.find((node) => node.author.name === 'Release Rota');
    const still = both.find((node) => node.author.name === first.author.name);

    console.log(
      'in two groups  :',
      both.map((node) => `${node.author.name}[${node.author.members.length}]`).join(', '),
    );

    if (rota === undefined) {
      problems.push('adding to a second group did not produce it');
    }

    if (still === undefined) {
      problems.push('adding to a second group took the person out of the first');
    }

    const rotaMembers = rota === undefined ? [] : await provider.getChildren(rota);

    if (rota !== undefined && rota.author.members.length !== inBoth.length) {
      problems.push(
        `the second group has ${rota.author.members.length} spellings, expected ${inBoth.length}`,
      );
    }

    if (rotaMembers.length !== inBoth.length) {
      problems.push(`the second group opened onto ${rotaMembers.length} spellings`);
    }

    // The row says where else the same person is listed, because the tree can only show one at once.
    const elsewhere = rotaMembers.map((node) => provider.getTreeItem(node).description).join(' | ');

    console.log('rota rows      :', elsewhere);

    if (!elsewhere.includes(first.author.name)) {
      problems.push('a spelling in two groups does not say so on either row');
    }

    /*
     * The rows have to be told apart. A tree hands two rows with the same id to the same element,
     * so a spelling listed under two groups would appear once and take its expansion with it.
     */
    const firstMembers = still === undefined ? [] : await provider.getChildren(still);
    const ids = [...firstMembers, ...rotaMembers].map((node) => provider.getTreeItem(node).id);

    if (new Set(ids).size !== ids.length) {
      problems.push('the same spelling under two groups was given the same row id in both');
    }

    // --- out of one of them, which has to leave the other standing --------------------------

    provider.removeFromGroup(inBoth, 'Release Rota');

    const afterOne = await provider.getChildren();

    console.log(
      'left one group :',
      afterOne.map((node) => node.author.name).join(', '),
    );

    if (afterOne.some((node) => node.author.name === 'Release Rota')) {
      problems.push('leaving a group left it behind with nobody in it');
    }

    if (!afterOne.some((node) => node.author.name === first.author.name)) {
      problems.push('leaving one group took the person out of the other as well');
    }

    provider.removeFromGroup(inBoth, first.author.name);

    const apart = await provider.getChildren();

    console.log('ungrouped      :', apart.map((node) => node.author.name).join(', '));

    if (apart.length !== people.length) {
      problems.push(`ungrouping left ${apart.length} people, expected ${people.length}`);
    }

    /*
     * And the rule's own answer can be overruled the other way.
     *
     * Four states, each with one thing worth offering, and the menu is driven entirely by which of
     * them a row is in - so a row in the wrong state is a row whose only useful action is missing.
     * Which is what happened: a group the *rule* folded offered nothing but "add to a group".
     */
    const before = provider.getTreeItem(first).contextValue;

    provider.setApart(provider.spellingsOf(first));
    const kept = provider.getTreeItem((await provider.getChildren())[0]).contextValue;

    provider.letTheRuleDecide(provider.spellingsOf(first));
    const back = provider.getTreeItem((await provider.getChildren())[0]).contextValue;

    console.log('row states     :', `${before} -> ${kept} -> ${back}`);

    if (kept !== 'weftAuthorGroupApart') {
      problems.push(`a spelling kept apart by hand is a ${kept}, so nothing offers to undo it`);
    }

    if (back !== before) {
      problems.push(`handing a spelling back to the rule left it a ${back}, not a ${before}`);
    }
  }
}

/*
 * One gesture, four sources. The filters live in three different places - the graph's search box,
 * its date range, and two tree views in Source Control - and the whole point of the button is that
 * the reader does not have to remember which of them they used. So set all of them, then check that
 * one click puts every one back and the history is whole again.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const refsHandler = checkboxHandlers.get('weft.refs');
  const authorsProvider = treeProviders.get('weft.authors');
  const authorsHandler = checkboxHandlers.get('weft.authors');
  /*
   * What the graph opened with, because that is what Clear Filters goes back to: the branch HEAD
   * is on. Show All Branches & Tags is the button that means every ref, and it is a different
   * gesture - "as it was when I opened it" and "everything there is" are not the same request.
   */
  const asOpened = posted.filter((m) => m.type === 'done')[0]?.total ?? 0;
  /** The walk this block starts from, which is what the filters below are narrowing. */
  const baseline = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;

  // A ref unticked, an author ticked, a search, and a date range that ends before the repository.
  const group = refsProvider.getChildren()[0];
  refsHandler({ items: [[refsProvider.getChildren(group)[0], 0]] });
  authorsHandler({ items: [[(await authorsProvider.getChildren())[0], 1]] });
  messageHandler({
    type: 'search',
    search: { query: 'commit', mode: 'message', regex: false, caseSensitive: false, allTerms: false, invert: false, follow: false },
  });
  await settle(posted.filter((m) => m.type === 'done').length - 1);

  const narrowed = await (async () => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'dates', range: { since: null, until: '2001-01-01' } });
    return settle(from);
  })();

  const flagged = posted.filter((m) => m.type === 'reset').pop()?.filtered;
  console.log('\nfilters set    :', narrowed, 'of', baseline, '| reset says filtered:', flagged);

  if (flagged !== true) {
    problems.push('the reset message did not report the graph as filtered');
  }

  const clearedFrom = posted.filter((m) => m.type === 'done').length;
  messageHandler({ type: 'clearFilters' });
  const restored = await settle(clearedFrom);

  const stillFlagged = posted.filter((m) => m.type === 'reset').pop()?.filtered;
  const hiddenRefs = refsProvider.getChildren(group).filter((r) => r.isHidden ?? false).length;

  console.log(
    'filters cleared:',
    restored,
    'of the',
    asOpened,
    'it opened with | view told:',
    posted.some((m) => m.type === 'filtersCleared'),
    '| reset says filtered:',
    stillFlagged,
  );

  if (restored !== asOpened) {
    problems.push(
      `clearing every filter left ${restored} commits, expected the ${asOpened} it opened with`,
    );
  }

  if (stillFlagged !== false) {
    problems.push('the graph still reports itself as filtered after everything was cleared');
  }

  if (!posted.some((m) => m.type === 'filtersCleared')) {
    problems.push('the view was never told to put its own boxes back');
  }

  if (hiddenRefs !== 0) {
    problems.push(`${hiddenRefs} refs were left unticked after clearing every filter`);
  }
}

/*
 * The auto-refresh check: commit from outside the extension, exactly as the user would from a
 * terminal, and the graph must reload itself without being asked. This is the failure mode the
 * whole watcher exists for.
 */
if (watchTest) {
  const before = posted.filter((m) => m.type === 'done').length;
  const beforeTotal = done?.total ?? 0;

  commitInto(repoPath, 99);
  console.log('\nexternal commit made; waiting for the graph to notice…');

  const started = Date.now();
  const deadline = started + 20_000;
  let reloaded = null;

  while (Date.now() < deadline) {
    const dones = posted.filter((m) => m.type === 'done');
    if (dones.length > before) {
      reloaded = dones[dones.length - 1];
      break;
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  if (reloaded === null) {
    problems.push('an external commit did not trigger a reload');
  } else {
    console.log(`reloaded       : ${Date.now() - started}ms after the commit`);
    console.log(`commits        : ${beforeTotal} -> ${reloaded.total}`);
    console.log('reloading msg  :', posted.some((m) => m.type === 'reloading') ? 'sent' : 'MISSING');

    if (reloaded.total !== beforeTotal + 1) {
      problems.push(`expected ${beforeTotal + 1} commits after the reload, got ${reloaded.total}`);
    }
  }

  // And the opposite: churn that changes no ref must not cost a reload.
  const quietFrom = posted.filter((m) => m.type === 'done').length;
  writeFileSync(join(repoPath, 'untracked.txt'), 'not a commit\n');
  /*
   * The reload being ruled out would arrive one watcher debounce - 600 ms - plus a walk after the
   * write, and a reload that never starts posts nothing to wait for. So this one stays a wait, long
   * enough that a reload on its way would have got here first.
   */
  await quiet(1500);

  if (posted.filter((m) => m.type === 'done').length > quietFrom) {
    problems.push('writing an untracked file triggered a needless reload');
  } else {
    console.log('quiet churn    : ignored, as it should be');
  }

  const walks = () => posted.filter((m) => m.type === 'done').length;
  const headsNodes = () => {
    const provider = treeProviders.get('weft.refs');
    return provider.getChildren(provider.getChildren().find((g) => g.id === 'heads'));
  };
  /** Which branch the graph was last told HEAD is on - the watcher's news of a checkout, arrived. */
  const namesBranch = () => posted.filter((m) => m.type === 'refs').pop()?.branch ?? null;
  const listsHead = (label) => headsNodes().some((node) => node.label === label);

  /*
   * A checkout to a branch at the same commit, made in a terminal. HEAD was fingerprinted by its
   * commit alone, so this reloaded nothing, and a graph following the branch you are on went on
   * drawing the one you had left.
   */
  runGit(repoPath, 'branch', 'twin');

  if (!(await until(() => listsHead('twin')))) {
    problems.push('a branch made in a terminal never reached Branches & Tags before the checkout');
  }

  const twinFrom = posted.length;
  runGit(repoPath, 'checkout', '-q', 'twin');

  const twinReloaded = await until(
    () => posted.slice(twinFrom).some((m) => m.type === 'done') && posted.slice(twinFrom).some((m) => m.type === 'refs'),
    15_000,
  );
  const named = posted.slice(twinFrom).filter((m) => m.type === 'refs').pop()?.branch ?? null;

  console.log('same commit    :', twinReloaded ? 'reloaded, names ' + named : 'NO RELOAD');

  if (!twinReloaded) {
    problems.push('checking out a branch at the same commit did not reload the graph');
  } else if (named !== 'twin') {
    problems.push('after checking out twin in a terminal the graph names ' + named);
  }

  /*
   * And straight back to main, which is where the graph used to stop being right about anything.
   *
   * The branch was made and then checked out, so the redraw for the first of those read the
   * repository after the second had landed: the graph named twin while the watcher's baseline still
   * said main. This checkout then matched that baseline exactly, the wake decided nothing had moved,
   * and the header went on naming twin - measured as no message of any kind for twenty seconds,
   * against a walk within one for the checkout onto twin.
   *
   * Both halves: the name comes back, and it costs no walk, because the two branches are at one commit
   * and there is nothing about the history that is different.
   */
  const backFrom = posted.length;
  const walksBeforeBack = posted.filter((m) => m.type === 'done').length;

  runGit(repoPath, 'checkout', '-q', 'main');

  const backNamed = await until(
    () => posted.slice(backFrom).some((m) => m.type === 'refs' && m.branch === 'main'),
    15_000,
  );

  await quiet();

  const backWalks = posted.filter((m) => m.type === 'done').length - walksBeforeBack;

  console.log('and back again :', backNamed ? 'names main' : 'STILL NAMES ' + namesBranch(), '|', backWalks, 'walk(s)');

  if (!backNamed) {
    problems.push('checking out main straight after twin left the graph naming ' + namesBranch());
  }

  if (backWalks > 0) {
    problems.push('naming the branch again cost ' + backWalks + ' walk(s) of a history that had not moved');
  }
  runGit(repoPath, 'branch', '-D', 'twin');
  await until(() => !listsHead('twin'));

  /*
   * A merge that stops on a conflict, started in a terminal. It moves no ref, so it walked nothing and
   * drew no banner until something else happened to reload the graph. The banner should come straight
   * away, and cost no walk.
   */
  const base = runGit(repoPath, 'rev-parse', 'main').trim();
  runGit(repoPath, 'checkout', '-q', '-b', 'clash-theirs');
  writeFileSync(join(repoPath, 'clash.txt'), 'theirs\n');
  runGit(repoPath, 'add', 'clash.txt');
  runGit(repoPath, 'commit', '-q', '-m', 'theirs');
  runGit(repoPath, 'checkout', '-q', '-b', 'clash-ours', base);
  writeFileSync(join(repoPath, 'clash.txt'), 'ours\n');
  runGit(repoPath, 'add', 'clash.txt');
  runGit(repoPath, 'commit', '-q', '-m', 'ours');

  /*
   * Until the graph has caught up with the branch this left HEAD on, and then a moment longer: what
   * is asserted below is that the merge itself walked nothing, and a walk still in flight from
   * setting the fixture up would be counted as the merge's.
   */
  await until(() => namesBranch() === 'clash-ours');
  await quiet();

  const mergeFrom = posted.length;

  try {
    runGit(repoPath, 'merge', '-q', 'clash-theirs');
  } catch {
    // git exits 1 when the merge stops on the conflict, which is the case being made.
  }

  const banner = await until(
    () => posted.slice(mergeFrom).some((m) => m.type === 'operation' && m.operation === 'merge'),
    15_000,
  );
  const walkedForIt = posted.slice(mergeFrom).some((m) => m.type === 'done');

  console.log('terminal merge :', banner ? 'banner drawn' : 'NO BANNER', '|', walkedForIt ? 'walked the history' : 'nothing walked');

  if (!banner) {
    problems.push('a merge that stopped on a conflict in a terminal drew no banner');
  }

  if (walkedForIt) {
    problems.push('the banner for a terminal merge cost a walk of the history');
  }

  const abortFrom = posted.length;
  runGit(repoPath, 'merge', '--abort');

  const cleared = await until(
    () => posted.slice(abortFrom).some((m) => m.type === 'operation' && m.operation === 'none'),
    15_000,
  );

  if (!cleared) {
    problems.push('aborting the terminal merge did not take the banner down');
  }

  runGit(repoPath, 'checkout', '-q', 'main');
  await until(() => namesBranch() === 'main');
  runGit(repoPath, 'branch', '-D', 'clash-theirs', 'clash-ours');
  await until(() => !headsNodes().some((node) => node.label.startsWith('clash-')));

  /*
   * A branch the graph is not drawing costs no walk - unless it points at something the graph has
   * drawn, where it is a badge like any other.
   *
   * Every ref that moved cost a walk of everything drawn, and on a repository with a thousand remote
   * branches a fetch moves dozens nobody has ticked. The walk decorates every row with every ref
   * pointing at it, though, so "not ticked" is not "not on screen", and both halves are checked here.
   */
  const narrowFrom = walks();
  await commands.get('weft.showCurrentRefOnly')();
  await settle(narrowFrom, SETTLING);

  // A commit hanging off main that main does not reach: nothing the graph has drawn.
  const offGraph = runGit(repoPath, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'off the graph').trim();
  const farFrom = walks();
  runGit(repoPath, 'branch', 'far', offGraph);

  /*
   * Until both places that list refs have heard of it - and then a moment more, because the other
   * half of this is that hearing of it cost no walk, and a walk is proved absent only by time.
   */
  await until(
    () =>
      listsHead('far') &&
      JSON.stringify(posted.filter((m) => m.type === 'refs').pop()?.refs ?? []).includes('refs/heads/far'),
  );
  await quiet();

  const farWalks = walks() - farFrom;
  const farNode = headsNodes().find((node) => node.label === 'far');
  const farInMenu = JSON.stringify(posted.filter((m) => m.type === 'refs').pop()?.refs ?? []).includes('refs/heads/far');

  console.log(
    'hidden branch  :',
    farWalks === 0 ? 'no walk' : farWalks + ' walk(s)',
    '| sidebar',
    farNode === undefined ? 'MISSING' : 'lists it',
    '| menu',
    farInMenu ? 'lists it' : 'MISSING',
  );

  if (farWalks !== 0) {
    problems.push('a branch the graph is not drawing, at a commit it has not drawn, re-walked the history');
  }

  if (farNode === undefined) {
    problems.push('Branches & Tags never heard of a branch made in a terminal');
  } else {
    // Ticked, it is drawn: one walk, which is the tick's own. So: wait for that walk, then for a
    // moment with no second one, which is the half of "one walk" that has nothing to poll for.
    const tickFrom = walks();
    checkboxHandlers.get('weft.refs')({ items: [[farNode, 1]] });
    await settle(tickFrom);
    await quiet();

    console.log('  ticked       :', walks() - tickFrom, 'walk(s)');

    if (walks() - tickFrom !== 1) {
      problems.push('ticking the hidden branch took ' + (walks() - tickFrom) + ' walks, not one');
    }
  }

  if (!farInMenu) {
    problems.push("the header's branch menu never heard of a branch made in a terminal");
  }

  // And a hidden branch made at a commit the graph has drawn is a badge on it, so that one walks.
  const currentFrom = walks();
  await commands.get('weft.showCurrentRefOnly')();
  await settle(currentFrom, SETTLING);

  const nearFrom = posted.length;
  runGit(repoPath, 'branch', 'near', 'main~1');

  const drawnBadge = () =>
    posted
      .slice(nearFrom)
      .filter((m) => m.type === 'page')
      .some((m) => m.rows.some((row) => JSON.stringify(row.refs).includes('near')));

  await until(drawnBadge);

  const badged = drawnBadge();

  console.log('  on a drawn row:', badged ? 'walked, badge drawn' : 'NO BADGE');

  if (!badged) {
    problems.push('a hidden branch made at a commit on screen never got its badge');
  }

  runGit(repoPath, 'branch', '-D', 'far', 'near');
  await until(() => !listsHead('far') && !listsHead('near'));

  /*
   * A hand-picked set stays hand-picked.
   *
   * The ticks were kept as the refs they hid, so a branch created after the choice was not among
   * them - and joined a set nobody had picked it for. After Show All, though, whatever arrives is
   * meant to be drawn, and still is.
   */
  const tickState = (label) => {
    const provider = treeProviders.get('weft.refs');
    const node = headsNodes().find((n) => n.label === label);
    return node === undefined ? 'missing' : provider.getTreeItem(node).checkboxState === 1 ? 'ticked' : 'unticked';
  };

  const untickFrom = walks();
  await commands.get('weft.untickAllRefs')();
  await settle(untickFrom, SETTLING);

  const mainNode = headsNodes().find((n) => n.label === 'main');
  const pickFrom = walks();

  if (mainNode !== undefined) {
    checkboxHandlers.get('weft.refs')({ items: [[mainNode, 1]] });
    await settle(pickFrom, SETTLING);
  }

  runGit(repoPath, 'branch', 'arrival', 'main');
  await until(() => listsHead('arrival'));
  const inPicked = tickState('arrival');

  const allFrom = walks();
  await commands.get('weft.showAllRefs')();
  await settle(allFrom, SETTLING);
  runGit(repoPath, 'branch', 'arrival-2', 'main');
  await until(() => listsHead('arrival-2'));
  const inAll = tickState('arrival-2');

  console.log('arrivals       : in a picked set', inPicked, '| after Show All', inAll);

  if (inPicked !== 'unticked') {
    problems.push('a branch created after picking only main arrived ' + inPicked + ', not unticked');
  }

  if (inAll !== 'ticked') {
    problems.push('a branch created after Show All arrived ' + inAll + ', not ticked');
  }

  runGit(repoPath, 'branch', '-D', 'arrival', 'arrival-2');

  // Gone from the sidebar before the ticks are put back: the next block reads the sidebar, and the
  // watcher's news of a deletion takes a debounce to arrive.
  if (!(await until(() => !headsNodes().some((node) => node.label.startsWith('arrival')), 10_000))) {
    problems.push('deleting two branches in a terminal never reached the sidebar');
  }

  /*
   * A branch made or deleted in a terminal reaches the sidebar, whatever walk reads the refs first.
   *
   * The watcher tells the sidebar only when its baseline is behind the refs, and every walk kept its
   * own read of them as the baseline - read after the sidebar's. A branch that moved while a walk was
   * starting was in the baseline and never in the sidebar, so the watcher's event for it found nothing
   * to report. It happened after the watcher's own walk, and after a walk for a filter that landed
   * inside the debounce. The second is forced here: the watcher is held off until the walk has read
   * the refs, by a file git has no use for, rewritten under .git - the watcher waits for quiet there.
   */
  // Quiet first, both times: the race below is between the watcher and a walk, and a watcher still
  // working through the branches deleted above would start it from somewhere nobody chose.
  await quiet();
  runGit(repoPath, 'branch', 'racer', 'main');

  if (!(await until(() => headsNodes().some((node) => node.label === 'racer'), 10_000))) {
    problems.push('a branch made in a terminal never reached Branches & Tags');
  }

  await quiet();
  runGit(repoPath, 'branch', '-D', 'racer');

  const nudge = join(repoPath, '.git', 'weft-nudge');
  const walksBefore = posted.filter((m) => m.type === 'done').length;
  let nudging = true;
  const nudger = (async () => {
    while (nudging) {
      writeFileSync(nudge, String(Date.now()));
      await new Promise((r) => setTimeout(r, 150));
    }
  })();

  await messageHandler({ type: 'order', order: 'topo' });
  await until(() => posted.filter((m) => m.type === 'done').length > walksBefore, 15_000);
  // Held on purpose rather than waited on: the nudger has to keep the watcher quiet for a moment
  // after the walk has finished, so that the walk's own read of the refs is the last one in.
  await quiet(1000);
  nudging = false;
  await nudger;

  const racerGone = await until(() => !headsNodes().some((node) => node.label === 'racer'), 10_000);

  console.log('raced deletion :', racerGone ? 'left the sidebar' : 'STILL LISTED');

  if (!racerGone) {
    problems.push('a branch deleted in a terminal stayed in Branches & Tags after a walk for a filter read the refs first');
  }

  const orderFrom = walks();
  await messageHandler({ type: 'order', order: 'date' });
  await settle(orderFrom, SETTLING);

  const endFrom = walks();
  await commands.get('weft.showCurrentRefOnly')();
  await settle(endFrom, SETTLING);
}

/*
 * The sidebar drives the graph from outside it, which is the case the rest of this run cannot see:
 * everything here happens *because* the graph lost focus, and a stub panel that is focused forever
 * is the one state where the bug this covers does not appear.
 *
 * It reloaded `WeftPanel.active()` - the *focused* graph - so ticking a box in Source Control,
 * which is itself the act of unfocusing the graph, reloaded nothing at all.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const refsHandler = checkboxHandlers.get('weft.refs');

  // From a known state. The block before this one cleared the filters, which puts the ticks back
  // to the branch HEAD is on - and "unticking narrows the walk" needs something to narrow.
  const wideFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();

  const baseline = await settle(wideFrom);

  // The graph is no longer the focused editor, exactly as it is not when a sidebar is being used.
  if (panelObject !== null && viewStateHandler !== null) {
    panelObject.active = false;
    viewStateHandler();
  }

  const groups = refsProvider.getChildren();
  const locals = refsProvider.getChildren(groups.find((g) => g.id === 'heads'));
  const side = locals.find((ref) => ref.label !== 'main') ?? locals[0];

  const from = posted.filter((m) => m.type === 'done').length;
  refsHandler({ items: [[side, 0]] });
  const unticked = await settle(from);

  console.log('\nunfocused graph:', unticked, 'of', baseline, 'after unticking', side.label);

  if (unticked === -1) {
    problems.push('unticking a ref while the graph was unfocused reloaded nothing');
  }

  if (unticked >= baseline) {
    problems.push(`unticking ${side.label} left ${unticked} of ${baseline} commits`);
  }

  await commands.get('weft.showAllRefs')();
  await settle(posted.filter((m) => m.type === 'done').length - 1);

  /*
   * And "show me only this branch", which unticking cannot express: what it narrows is the set of
   * tips git walks *from*, so hiding one branch changes nothing while its commits are still
   * reachable from another - which for a branch that has been merged is always.
   */
  /*
   * `main` rather than `side`: in this fixture `side` is ahead of `main` and reaches every commit,
   * so narrowing to it narrows nothing - which is the very thing that makes unticking the wrong
   * shape for this question, and a useless assertion to hang a test on.
   */
  const trunk = locals.find((ref) => ref.label === 'main') ?? side;
  const onlyFrom = posted.filter((m) => m.type === 'done').length;

  await commands.get('weft.showOnlyRef')(trunk);
  const only = await settle(onlyFrom);

  const shown = refsProvider
    .getChildren()
    .flatMap((g) => refsProvider.getChildren(g))
    .filter((ref) => refsProvider.getTreeItem(ref).checkboxState === 1);

  console.log(
    'show only      :',
    trunk.label,
    '->',
    only,
    'of',
    baseline,
    'commits |',
    shown.length,
    'ref ticked:',
    shown.map((r) => r.label).join(', '),
  );

  if (shown.length !== 1 || shown[0]?.refName !== trunk.refName) {
    problems.push(`Show Only This left ${shown.length} refs ticked, expected just ${trunk.label}`);
  }

  if (only >= baseline) {
    problems.push(`showing only ${trunk.label} left ${only} of ${baseline} commits`);
  }

  await commands.get('weft.showAllRefs')();
  await settle(posted.filter((m) => m.type === 'done').length - 1);

  // Put the focus back, so nothing after this is measuring a different window than it thinks.
  if (panelObject !== null && viewStateHandler !== null) {
    panelObject.active = true;
    viewStateHandler();
  }
}

/*
 * `--first-parent` is two halves - an argument to git and an option to the layout - and only one of
 * them is visible from here. The argument is: every command Weft runs is logged, so the walk can
 * be read back rather than inferred from a commit count that a linear fixture would not change.
 */
{
  const walks = () => outputLines.filter((line) => line.includes('git log'));
  const before = walks().length;

  messageHandler({ type: 'firstParent', on: true });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && walks().length === before) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const mainline = walks().pop() ?? '';
  const flagged = posted.filter((m) => m.type === 'reset').pop()?.filtered;

  console.log('\nfirst parent   :', mainline.includes('--first-parent') ? 'in the walk' : 'MISSING', '| reset says filtered:', flagged);

  if (!mainline.includes('--first-parent')) {
    problems.push('first parent was turned on but the walk did not ask git for it');
  }

  if (flagged !== true) {
    problems.push('walking only the mainline was not counted as filtering');
  }

  const off = walks().length;
  messageHandler({ type: 'firstParent', on: false });

  const restore = Date.now() + 20_000;
  while (Date.now() < restore && walks().length === off) {
    await new Promise((r) => setTimeout(r, 25));
  }

  if ((walks().pop() ?? '').includes('--first-parent')) {
    problems.push('turning first parent off left it on the command line');
  }
}

/*
 * The header's branch menu, and the one piece of state it shares with the sidebar.
 *
 * The menu is a second way into the ticks in Branches & Tags, not a second copy of them. What that
 * has to mean is checked from both ends here: the list the host sends reports what the tree
 * believes, and a toggle arriving from the webview changes what the next walk is given.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const sent = posted.filter((m) => m.type === 'refs').at(-1);

  console.log(
    '\nbranch menu    :',
    sent === undefined ? 'NOTHING SENT' : `${sent.refs.length} refs, on ${sent.branch}`,
  );

  if (sent === undefined) {
    problems.push('the header was never told what refs exist');
  } else {
    if (sent.branch !== 'main') {
      problems.push(`the branch menu was told HEAD is on ${sent.branch}`);
    }

    // Every ref, not only the drawn ones: a menu that drops what it is hiding gives you no way to
    // put it back.
    if (sent.refs.length !== refsProvider.listRefs().length) {
      problems.push(
        `the menu was sent ${sent.refs.length} refs and the tree has ${refsProvider.listRefs().length}`,
      );
    }

    const kinds = [...new Set(sent.refs.map((ref) => ref.kind))].sort();

    if (kinds.join(',') !== 'local,remote,tag' && kinds.join(',') !== 'local,tag') {
      problems.push(`the menu was sent refs of kinds ${kinds.join(', ')}`);
    }
  }

  // --- and the toggle, arriving the way the webview sends it ---------------------------------
  const victim = sent?.refs.find((ref) => ref.kind === 'local' && ref.label !== 'main');

  if (victim === undefined) {
    problems.push('no branch to hide from the header');
  } else {
    const walksBefore = posted.filter((m) => m.type === 'done').length;

    await messageHandler({ type: 'setRefsVisible', refNames: [victim.refName], visible: false });

    const by = Date.now() + 10_000;
    while (Date.now() < by && posted.filter((m) => m.type === 'done').length === walksBefore) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const walked = refsProvider.visibleRefs(refsProvider.repoRoot);
    const hiddenNow = walked !== null && !walked.includes(victim.refName);
    const tickOff = refsProvider
      .getChildren(refsProvider.getChildren().find((g) => g.id === 'heads'))
      .some((node) => node.refName === victim.refName && refsProvider.getTreeItem(node).checkboxState === 0);

    console.log(
      'hid from header:',
      victim.label,
      '| out of the walk:',
      hiddenNow,
      '| tick cleared:',
      tickOff,
      '| reloaded:',
      posted.filter((m) => m.type === 'done').length > walksBefore,
    );

    if (!hiddenNow) {
      problems.push(`hiding ${victim.label} from the header did not take it out of the walk`);
    }

    // The same state, so the sidebar has to agree without being told separately.
    if (!tickOff) {
      problems.push(`hiding ${victim.label} from the header left its tick set in the sidebar`);
    }

    if (posted.filter((m) => m.type === 'done').length === walksBefore) {
      problems.push('hiding a branch from the header did not redraw the graph');
    }

    /*
     * And the same question asked on behalf of a different repository.
     *
     * Every open graph reloads when a tick moves, and each asks what to walk. Before the roots were
     * passed, the second graph got the first one's ref names - which name nothing in it, so git
     * walked nothing and it went blank. The filters belong to the repository the sidebar is
     * showing, and to no other.
     */
    const foreign = refsProvider.visibleRefs('D:/somewhere/else');
    const authorsForeign = treeProviders.get('weft.authors').authorPicks('D:/somewhere/else');

    console.log('other repo     : refs ->', foreign, '| authors ->', authorsForeign.length, 'people');

    if (foreign !== null) {
      problems.push(`a second repository was told to walk ${foreign.length} refs belonging to this one`);
    }

    if (authorsForeign.length > 0) {
      problems.push("a second repository was given this one's author filter");
    }

    // --- and a whole group at once, which is what the heading's tick sends ------------------
    const many = sent.refs.filter((ref) => ref.kind === 'local').map((ref) => ref.refName);
    const walksBeforeGroup = posted.filter((m) => m.type === 'done').length;

    await messageHandler({ type: 'setRefsVisible', refNames: many, visible: false });
    // The walk the message is owed, and then a moment for the ones it is not: "one walk" is half a
    // count and half an absence, and only the first half has anything to wait for.
    await settle(walksBeforeGroup);
    await quiet();

    const walks = posted.filter((m) => m.type === 'done').length - walksBeforeGroup;
    console.log('group of', many.length, 'hidden:', walks, 'walk' + (walks === 1 ? '' : 's'));

    // One message, one walk. Sending these one at a time would redraw the history per branch,
    // which is the reason the message carries a list rather than a name.
    if (walks !== 1) {
      problems.push(`hiding ${many.length} branches at once cost ${walks} walks of the history`);
    }

    const backFrom = posted.filter((m) => m.type === 'done').length;
    await commands.get('weft.showAllRefs')();
    await settle(backFrom, SETTLING);
  }
}

/*
 * The manifest's menus against the context values the trees actually emit.
 *
 * A `when` clause naming a context value nothing produces is a menu entry that silently is not
 * there - no error, no warning, just a right-click missing an item. The same shape as a view id
 * going stale, and invisible in the same way.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const groups = refsProvider.getChildren();

  const kindOf = (groupId) => {
    const node = refsProvider.getChildren(groups.find((g) => g.id === groupId))[0];
    return node === undefined ? null : refsProvider.getTreeItem(node).contextValue;
  };

  const emitted = { local: kindOf('heads'), tag: kindOf('tags') };
  console.log('\nref contexts   :', JSON.stringify(emitted));

  /** Enough of the `when` language for the forms this manifest uses. */
  const matches = (when, viewItem) => {
    const clauses = when.split('&&').map((c) => c.trim());

    return clauses.every((clause) => {
      if (clause.startsWith('view ==')) {
        return clause.includes('weft.refs');
      }

      const regex = /^viewItem\s*=~\s*\/(.+)\/$/.exec(clause);

      if (regex !== null) {
        return new RegExp(regex[1]).test(viewItem);
      }

      const equals = /^viewItem\s*==\s*(\S+)$/.exec(clause);
      return equals === null ? true : equals[1] === viewItem;
    });
  };

  const refMenus = manifest.contributes.menus['view/item/context'].filter(
    (entry) => (entry.when ?? '').includes('weft.refs'),
  );

  for (const entry of refMenus) {
    const hits = ['local', 'tag', 'remote']
      .filter((kind) => matches(entry.when, emitted[kind] ?? `weftRef${kind[0].toUpperCase()}${kind.slice(1)}`));

    // An entry for a heading matches no ref by design; the allow-list below is what holds it.
    if (hits.length === 0 && !/viewItem == weftGroup/.test(entry.when)) {
      problems.push(`${entry.command} is in the manifest but its when clause matches no ref`);
    }
  }

  /*
   * And the headings, which offer nothing - or exactly what their allow-list says. Their context
   * values are named by group and never begin "weftRef", because the menus select branch commands
   * with viewItem =~ /^weftRef/, and a heading that matched offered five commands that did nothing.
   */
  const HEADING_MENUS = { weftGroupHeads: ['weft.cleanUpBranches'], weftGroupRemotes: [], weftGroupTags: [] };

  for (const group of groups) {
    const value = refsProvider.getTreeItem(group).contextValue;
    const offered = refMenus.filter((entry) => matches(entry.when, value)).map((entry) => entry.command);
    const allowed = HEADING_MENUS[value];

    if (allowed === undefined) {
      problems.push(`the ${group.id} heading has context value ${value}, which no allow-list here names`);
    } else if (offered.join() !== allowed.join()) {
      problems.push(
        `the ${group.id} heading offers ${offered.join(', ') || 'nothing'}, expected ${allowed.join(', ') || 'nothing'}`,
      );
    }
  }

  /*
   * Folders: refs sharing a prefix are gathered under it. Three branches here, two Dev_ and one Fix_,
   * which fold as a Dev_ folder of two and a Fix_one on its own. A folder offers no branch's menu, and
   * ticking it ticks what is inside.
   */
  runGit(repoPath, 'branch', 'Dev_one');
  runGit(repoPath, 'branch', 'Dev_two');
  runGit(repoPath, 'branch', 'Fix_one');
  await refsProvider.reload();

  const headsGroup = refsProvider.getChildren().find((g) => g.id === 'heads');
  const folder = refsProvider.getChildren(headsGroup).find((node) => node.kind === 'folder');
  const inside = folder === undefined ? [] : refsProvider.getChildren(folder);
  const folderItem = folder === undefined ? null : refsProvider.getTreeItem(folder);
  const loose = refsProvider
    .getChildren(headsGroup)
    .filter((node) => node.kind === 'ref')
    .map((node) => refsProvider.getTreeItem(node).label);

  console.log(
    'folders        :',
    folderItem === null ? 'NONE' : `${folderItem.label} (${folderItem.description})`,
    '| inside',
    JSON.stringify(inside.map((node) => refsProvider.getTreeItem(node).label)),
    '| loose',
    JSON.stringify(loose),
  );

  if (folderItem === null || folderItem.label !== 'Dev_' || inside.length !== 2) {
    problems.push('Dev_one and Dev_two did not fold into a Dev_ folder of two: ' + JSON.stringify(folderItem?.label ?? null));
  } else {
    const folderOffers = refMenus.filter((entry) => matches(entry.when, folderItem.contextValue)).map((entry) => entry.command);

    if (folderItem.contextValue !== 'weftFolder' || folderOffers.length > 0) {
      problems.push(`a folder has context value ${folderItem.contextValue} and offers ${folderOffers.join(', ') || 'nothing'}`);
    }

    // From nothing ticked: the two arrived ticked, so a tick that reached neither would pass for one
    // that reached both.
    await commands.get('weft.untickAllRefs')();

    const states = () => inside.map((node) => refsProvider.getTreeItem(node).checkboxState);
    const before = states();
    checkboxHandlers.get('weft.refs')({ items: [[folder, 1]] });
    const ticked = states();
    checkboxHandlers.get('weft.refs')({ items: [[folder, 0]] });
    const unticked = states();

    console.log('  folder tick  :', JSON.stringify(before), '->', JSON.stringify(ticked), '->', JSON.stringify(unticked));

    if (!before.every((state) => state === 0)) {
      problems.push('Untick All left a branch in the Dev_ folder ticked: ' + JSON.stringify(before));
    } else if (!ticked.every((state) => state === 1) || !unticked.every((state) => state === 0)) {
      problems.push('the Dev_ folder tick did not reach both branches inside it: ' + JSON.stringify({ ticked, unticked }));
    }
  }

  if (!loose.includes('Fix_one')) {
    problems.push('Fix_one, the only Fix_ branch, was folded: ' + JSON.stringify(loose));
  }

  runGit(repoPath, 'branch', '-D', 'Dev_one', 'Dev_two', 'Fix_one');
  await commands.get('weft.showCurrentRefOnly')();
  await refsProvider.reload();

  const offeredBy = (command) =>
    ['local', 'tag', 'remote'].filter((kind) =>
      refMenus.some(
        (entry) =>
          entry.command === command &&
          matches(entry.when, emitted[kind] ?? `weftRef${kind[0].toUpperCase()}${kind.slice(1)}`),
      ),
    );

  const deletable = offeredBy('weft.deleteRef');
  const remotely = offeredBy('weft.deleteRemoteRef');

  console.log('delete offered : local/tag ->', deletable.join(', ') || '(nothing)',
    '| remote ->', remotely.join(', ') || '(nothing)');

  if (deletable.join(',') !== 'local,tag') {
    problems.push(`Delete is offered for ${deletable.join(', ') || 'nothing'}, expected local and tag`);
  }

  // The two must not overlap. Plain "Delete" reaching a remote branch would make a push out of a
  // word people read as local, which is the confusion the second command exists to prevent.
  if (remotely.join(',') !== 'remote') {
    problems.push(
      `Delete on Remote is offered for ${remotely.join(', ') || 'nothing'}, expected remote alone`,
    );
  }

  // And it refuses a remote branch even when called directly, rather than leaving a menu clause as
  // the only thing between a tree node and a push. Anything it did say would land on the stub's
  // message handlers, which count every unexpected one as a failure.
  const remoteNode = refsProvider.getChildren(groups.find((g) => g.id === 'remotes'))[0];

  if (remoteNode !== undefined) {
    await commands.get('weft.deleteRef')(remoteNode);
  }
}

/*
 * Copying, from both trees. Each command is handed the node the tree would hand it, so what is
 * being checked is the whole path from a row to the clipboard - not that a string was formatted.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const filesProvider = treeProviders.get('weft.files');

  const groups = refsProvider.getChildren();
  const ref = refsProvider.getChildren(groups.find((g) => g.id === 'heads'))[0];

  copied.length = 0;
  await commands.get('weft.copyRefName')(ref);
  await commands.get('weft.copyFullRefName')(ref);

  console.log('\ncopy (ref)     :', copied.join('  |  '));

  if (copied[0] !== ref.label) {
    problems.push(`copying a branch name gave ${copied[0]}, expected ${ref.label}`);
  }

  // The full name is what git wants and the label is not: `main` reads, `refs/heads/main` resolves.
  if (copied[1] !== ref.refName || !String(copied[1]).startsWith('refs/')) {
    problems.push(`copying a full ref name gave ${copied[1]}, expected ${ref.refName}`);
  }

  const nodes = [];
  const walk = (list) => {
    for (const node of list) {
      if (node.kind === 'file') {
        nodes.push(node);
      } else {
        walk(filesProvider.getChildren(node));
      }
    }
  };

  walk(filesProvider.getChildren());

  if (nodes.length === 0) {
    problems.push('no file to copy a path from');
  } else {
    copied.length = 0;
    await commands.get('weft.copyFilePath')(nodes[0]);
    await commands.get('weft.copyAbsoluteFilePath')(nodes[0]);

    console.log('copy (file)    :', copied.join('  |  '));

    if (copied[0] !== nodes[0].file.path) {
      problems.push(`copying a path gave ${copied[0]}, expected ${nodes[0].file.path}`);
    }

    // Absolute means absolute: rooted at the repository, not the same string with a slash on it.
    if (!String(copied[1]).endsWith(nodes[0].file.path.replace(/\//g, sep)) || copied[1] === copied[0]) {
      problems.push(`copying an absolute path gave ${copied[1]}, which is not ${nodes[0].file.path} under the repository`);
    }
  }
}

/*
 * One file's history, end to end - and the half of it that only a real repository can answer:
 * whether `--follow` actually reaches back past a rename. The fixture renames a file and commits
 * on both sides of it, so a path search without following stops at the rename and one with it does
 * not. Asserting the flag reached the command line would only prove that it was typed.
 */
{
  const renamed = 'renamed.txt';

  writeFileSync(join(repoPath, 'before-rename.txt'), 'first\n');
  runGit(repoPath, 'add', '-A');
  runGit(repoPath, 'commit', '-q', '-m', 'add before-rename.txt');
  runGit(repoPath, 'mv', 'before-rename.txt', renamed);
  runGit(repoPath, 'commit', '-q', '-m', 'rename before-rename.txt');
  writeFileSync(join(repoPath, renamed), 'first\nsecond\n');
  runGit(repoPath, 'add', '-A');
  runGit(repoPath, 'commit', '-q', '-m', 'edit renamed.txt');

  const runSearch = async (search) => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'search', search });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length === from) {
      await new Promise((r) => setTimeout(r, 25));
    }

    return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  };

  const base = { query: renamed, mode: 'path', regex: false, caseSensitive: false, allTerms: false, invert: false };
  const withoutFollow = await runSearch({ ...base, follow: false });
  const withFollow = await runSearch({ ...base, follow: true, caseSensitive: true });

  console.log('\nfile history   :', renamed, '|', withoutFollow, 'commits touching it,', withFollow, 'following renames');

  if (withoutFollow < 1) {
    problems.push(`a path search for ${renamed} found ${withoutFollow} commits`);
  }

  if (withFollow <= withoutFollow) {
    problems.push(
      `--follow found ${withFollow} commits where a plain path search found ${withoutFollow}; it did not reach past the rename`,
    );
  }

  await runSearch(null);
}

/*
 * The two author filters, on one command line.
 *
 * The Authors sidebar and the search box's author mode both say `--author`, and git reads several
 * of those as "any of these" - so ticking one person and typing another used to hand back *both*,
 * more rows than either filter alone. Read off the command line rather than inferred, because the
 * count alone cannot tell an intersection from a union on a fixture with two authors.
 */
{
  const provider = treeProviders.get('weft.authors');
  const handler = checkboxHandlers.get('weft.authors');
  const walks = () => outputLines.filter((line) => line.includes('git log'));

  const query = async (search) => {
    const from = posted.filter((m) => m.type === 'done').length;
    messageHandler({ type: 'search', search });
    const total = await settle(from);
    return { total, walk: walks().pop() ?? '' };
  };

  const people = await provider.getChildren();
  const mine = people.find((node) => node.author.name === 'Weft Test');
  const other = people.find((node) => node.author.name === 'Someone Else');

  if (mine === undefined || other === undefined) {
    problems.push(`the fixture's authors are ${people.map((n) => n.author.name).join(', ')}`);
  } else {
    const from = posted.filter((m) => m.type === 'done').length;
    handler({ items: [[mine, 1]] });
    const ticked = await settle(from);

    const author = (text) => ({
      query: text,
      mode: 'author',
      regex: false,
      caseSensitive: false,
      allTerms: false,
      invert: false,
      follow: false,
    });

    // Someone the tick has already ruled out. A union would have brought their commits back.
    const apart = await query(author('Someone'));

    // And a name the tick agrees with, which has to leave the tick standing rather than replace it.
    const together = await query(author('Weft'));

    const authorFlags = (walk) => (walk.match(/--author=/g) ?? []).length;

    console.log('');
    console.log('author ticked  :', ticked, 'commits');
    console.log('  + "Someone"  :', apart.total, 'commits |', authorFlags(apart.walk), '--author on the walk');
    console.log('  + "Weft"     :', together.total, 'commits |', authorFlags(together.walk), '--author on the walk');

    if (apart.total > ticked) {
      problems.push(
        `a tick and an author search gave ${apart.total} commits where the tick alone gave ${ticked}: the two widened each other`,
      );
    }

    if (apart.total !== 0) {
      problems.push(`searching for an author the tick rules out left ${apart.total} commits`);
    }

    // The one that would have opened the whole history: no --author at all is not "nobody" to git.
    if (authorFlags(apart.walk) !== 1) {
      problems.push(
        `an empty intersection put ${authorFlags(apart.walk)} --author on the walk, and none of them means no filter`,
      );
    }

    if (together.total !== ticked) {
      problems.push(
        `searching for the ticked author's own name gave ${together.total} of ${ticked} commits`,
      );
    }

    if (!together.walk.includes('--author=Weft Test')) {
      problems.push('the query replaced the ticked spelling instead of narrowing to it');
    }

    await query(null);
    const cleared = posted.filter((m) => m.type === 'done').length;
    handler({ items: [[mine, 0]] });
    await settle(cleared);
  }
}

/*
 * Comparing two commits, end to end: two shas -> `git diff --raw` -> a file list with a blob on
 * both sides -> a diff addressed by those blobs. The counts come from the symmetric difference, so
 * a pair that has diverged gets a number for each side rather than one that has to pick a side.
 */
{
  const rows = posted.filter((m) => m.type === 'page').flatMap((m) => m.rows);
  const newest = rows[0];
  const oldest = rows[rows.length - 1];

  if (newest === undefined || oldest === undefined || newest.sha === oldest.sha) {
    problems.push('not enough commits to compare');
  } else {
    const before = posted.filter((m) => m.type === 'comparison').length;
    messageHandler({
      type: 'compare',
      from: { rev: oldest.sha, label: oldest.sha.slice(0, 8) },
      to: { rev: newest.sha, label: newest.sha.slice(0, 8) },
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'comparison').length === before) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const comparison = posted.filter((m) => m.type === 'comparison').pop();

    console.log(
      '\ncompare        :',
      comparison === undefined
        ? 'NO ANSWER'
        : `${comparison.from.label} → ${comparison.to.label} | ${comparison.files} files | ${comparison.onlyFrom} left, ${comparison.onlyTo} right`,
    );

    if (comparison === undefined) {
      problems.push('comparing two commits produced nothing');
    } else {
      if (comparison.files === 0) {
        problems.push('comparing the first and last commit found no changed files');
      }

      // The root is an ancestor of the tip, so everything is on one side and nothing on the other.
      if (comparison.onlyFrom !== 0 || comparison.onlyTo === 0) {
        problems.push(
          `an ancestor compared to its descendant came back ${comparison.onlyFrom} left and ${comparison.onlyTo} right`,
        );
      }

      const provider = treeProviders.get('weft.files');
      const nodes = [];
      const walk = (list) => {
        for (const node of list) {
          if (node.kind === 'file') {
            nodes.push(node);
          } else {
            walk(provider.getChildren(node));
          }
        }
      };

      walk(provider.getChildren());

      console.log('  section says :', treeViews.get('weft.files')?.description ?? 'NO DESCRIPTION');

      if (nodes.length !== comparison.files) {
        problems.push(`the section listed ${nodes.length} files, the comparison found ${comparison.files}`);
      }

      // A file opened from a range diffs blob against blob, not against the working tree.
      diffsOpened.length = 0;
      await commands.get('weft.openCommitFile')(nodes[0]);

      const opened = diffsOpened[0];

      if (opened === undefined) {
        problems.push('opening a file from a comparison produced no diff');
      } else {
        console.log('  diff         :', opened.title);

        if (!opened.title.includes('→')) {
          problems.push(`a comparison diff is titled ${opened.title}`);
        }

        const contents = contentProviders.get('weft-git');
        const right = await contents.provideTextDocumentContent(opened.right);

        if (right.length === 0 && nodes[0].file.newBlob !== null) {
          problems.push('the newer side of a comparison diff came back empty');
        }
      }
    }
  }
}

/*
 * Two refs compared by name, from Branches & Tags: main and the tag v1.0, answered and headed as the
 * refs they are rather than as eight characters of a hash - in the pane and in Commit Files.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const heads = refsProvider.getChildren(refsProvider.getChildren().find((g) => g.id === 'heads'));
  const mainNode = heads.find((node) => node.label === 'main');
  const before = posted.filter((m) => m.type === 'comparison').length;

  // The branch HEAD is on drawn and nothing else, so the tag is an end the graph is not drawing.
  const onlyHeadFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showCurrentRefOnly')();
  await settle(onlyHeadFrom, SETTLING);

  pickAnswers.push('v1.0');
  await commands.get('weft.compareRef')(mainNode);

  const by = Date.now() + 20_000;
  while (Date.now() < by && posted.filter((m) => m.type === 'comparison').length === before) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const answer = posted.filter((m) => m.type === 'comparison').length > before ? posted.filter((m) => m.type === 'comparison').pop() : undefined;
  const heading = String(treeViews.get('weft.files')?.description ?? '');

  console.log(
    'compare refs   :',
    answer === undefined ? 'NO ANSWER' : `${answer.from.label} → ${answer.to.label} | ${answer.onlyFrom} left, ${answer.onlyTo} right`,
    '| Commit Files',
    JSON.stringify(heading),
  );

  if (answer === undefined || answer.from.label !== 'main' || answer.to.label !== 'v1.0') {
    problems.push('comparing main with v1.0 from Branches & Tags answered ' + JSON.stringify(answer ? [answer.from, answer.to] : null));
  } else if (answer.from.sha !== runGit(repoPath, 'rev-parse', 'main').trim()) {
    problems.push("the comparison's main is not main's commit");
  }

  if (!heading.startsWith('main → v1.0')) {
    problems.push('Commit Files headed the comparison ' + JSON.stringify(heading) + ', not with the two names');
  }

  if (answer !== undefined) {
    console.log(
      '  sides        :',
      answer.onlyFromCommits.length, 'of', answer.onlyFrom, 'and', answer.onlyToCommits.length, 'of', answer.onlyTo,
      'listed | drawn', answer.from.drawn, answer.to.drawn,
    );

    if (
      answer.onlyFromCommits.length !== Math.min(100, answer.onlyFrom) ||
      answer.onlyToCommits.length !== Math.min(100, answer.onlyTo)
    ) {
      problems.push(`the comparison listed ${answer.onlyFromCommits.length} and ${answer.onlyToCommits.length} commits for sides of ${answer.onlyFrom} and ${answer.onlyTo}`);
    }

    if (answer.from.drawn !== true || answer.to.drawn !== false) {
      problems.push(`with main drawn and v1.0 not, the comparison said ${answer.from.drawn} and ${answer.to.drawn}`);
    }
  }
}

/*
 * The working tree's own row - the one row in the graph that is not a commit, and so the one that
 * takes a path nothing else here exercises: `git status` -> a `working` message -> a file list with
 * no blob OIDs on either side -> a diff whose right-hand side is the file on disk.
 */
{
  writeFileSync(join(repoPath, 'f1.txt'), 'edited but not committed\n');
  // Its own untracked file rather than one an earlier section happened to leave behind: that
  // one only exists under --watch, and a test that passes depending on a flag is not one.
  writeFileSync(join(repoPath, 'never-added.txt'), 'not in the index\n');

  const from = posted.filter((m) => m.type === 'done').length;
  messageHandler({ type: 'refresh' });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length === from) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const state = posted.filter((m) => m.type === 'working').pop();

  /*
   * The counts beside the title are a statement about the last fetch, not about now - `origin/main`
   * is a local pointer only a fetch moves. Without the timestamp travelling with them they read as
   * current, which is exactly how a graph tells you that you are up to date when you are not.
   */
  if (state !== undefined && !('fetchedAt' in state)) {
    problems.push('the working message does not say when the remote was last heard from');
  }

  console.log(
    '\nworking tree   :',
    state === undefined
      ? 'NOT REPORTED'
      : `${state.total} files on ${state.branch} (${state.unstaged} unstaged, ${state.untracked} untracked)`,
  );

  if (state === undefined || state.total === 0) {
    problems.push('a dirty working tree was not reported to the view');
  } else if (state.unstaged === 0 || state.untracked === 0) {
    problems.push(
      `the working tree came back as ${state.unstaged} unstaged and ${state.untracked} untracked; both were expected`,
    );
  }

  await messageHandler({ type: 'selectUncommitted' });

  const provider = treeProviders.get('weft.files');
  const nodes = [];
  const walk = (list) => {
    for (const node of list) {
      if (node.kind === 'file') {
        nodes.push(node);
      } else {
        walk(provider.getChildren(node));
      }
    }
  };

  walk(provider.getChildren());

  console.log('  files listed :', nodes.map((n) => `${n.file.status} ${n.file.path}`).join(', ') || '(none)');
  console.log('  section says :', treeViews.get('weft.files')?.description ?? 'NO DESCRIPTION');

  if (state !== undefined && nodes.length !== state.total) {
    problems.push(`the section listed ${nodes.length} working-tree files, git status found ${state.total}`);
  }

  if (!nodes.some((n) => n.file.status === '?')) {
    problems.push('an untracked file was not listed as untracked');
  }

  const edited = nodes.find((n) => n.file.status === 'M');

  if (edited === undefined) {
    problems.push('the edited file was not listed as modified');
  } else {
    diffsOpened.length = 0;
    await commands.get('weft.openCommitFile')(edited);

    const opened = diffsOpened[0];

    if (opened === undefined) {
      problems.push('opening an uncommitted file produced no diff');
    } else {
      console.log('  diff         :', opened.title);

      if (!opened.title.includes('working tree')) {
        problems.push(`an uncommitted diff was titled ${opened.title}`);
      }

      // The right side is the file itself, not a revision Weft serves.
      if (!String(opened.right.fsPath ?? '').endsWith('f1.txt')) {
        problems.push('the right side of an uncommitted diff is not the file on disk');
      }

      // The left side has no blob OID, so it can only come back through `HEAD:<path>`.
      const contents = contentProviders.get('weft-git');
      const left = await contents.provideTextDocumentContent(opened.left);

      console.log('  HEAD side    :', left.length, 'chars');

      if (left.length === 0) {
        problems.push('the HEAD side of an uncommitted diff came back empty');
      }

      if (left.includes('edited but not committed')) {
        problems.push('the HEAD side of an uncommitted diff shows the working copy');
      }
    }
  }
}

/*
 * The three things the stub could not do until it stopped pretending: the built-in git extension
 * existing, a setting having a value other than its default, and the panel being closed. Each of
 * them gates a path that had never run a line here.
 */
{
  // --- the working tree, told to us by someone else -----------------------------------------
  const walksBefore = posted.filter((m) => m.type === 'done').length;
  const workingBefore = posted.filter((m) => m.type === 'working').length;

  writeFileSync(join(repoPath, 'f1.txt'), 'edited again, without committing\n');
  repositoryState.fire();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && posted.filter((m) => m.type === 'working').length === workingBefore) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const walksAfter = posted.filter((m) => m.type === 'done').length;
  const told = posted.filter((m) => m.type === 'working').length > workingBefore;

  console.log('\nworking events :', told ? 'the view was told' : 'NOT TOLD', '| walks:', walksBefore, '->', walksAfter);

  if (!told) {
    problems.push('a working-tree change from the git extension never reached the view');
  }

  // The whole point of listening rather than reloading: one `git status`, not a walk.
  if (walksAfter !== walksBefore) {
    problems.push('a file being saved re-walked the history');
  }

  /*
   * And several at once. Each event was a git status of our own, however close together they came -
   * side by side, on a repository where each takes the better part of a second. Five in one go must
   * be one read: they are fired synchronously, so no timing on this machine can split them.
   */
  /*
   * Quiet first. Writing f1.txt above is a working-tree event of its own, and a read still inside
   * its 150 ms debounce would be counted among the burst's - so the wait is for nothing being in
   * flight, which is a thing with no message to poll for.
   */
  await quiet();

  const statusRuns = () => outputLines.filter((l) => l.startsWith('debug') && l.includes('git status ')).length;
  const burstFrom = statusRuns();
  const burstWalks = posted.filter((m) => m.type === 'done').length;

  for (let i = 0; i < 5; i += 1) {
    repositoryState.fire();
  }

  // The one read the five are owed, and then a stretch with no second one - the half of "one read"
  // that is an absence.
  await until(() => statusRuns() > burstFrom);
  await quiet();

  const burstRan = statusRuns() - burstFrom;
  console.log('working burst  : 5 events ->', burstRan, 'status runs');

  if (burstRan !== 1) {
    problems.push('a burst of 5 working-tree events ran git status ' + burstRan + ' times, not once');
  }

  if (posted.filter((m) => m.type === 'done').length !== burstWalks) {
    problems.push('a burst of working-tree events re-walked the history');
  }

  /*
   * A slow git status gets one offer, with the fix on a button - and "Never" is kept, with git's own
   * settings left exactly as they were. A threshold of 1 ms makes every read a slow one.
   */
  settings.set('weft.statusSlowMs', 1);
  infoAnswers.length = 0;
  infoAnswers.push('Never for This Repository');
  const offersFrom = offers.length;

  // Five reads, not five events coalesced into one: each is waited for by the read it causes, since
  // what the offer is made for is a run of slow reads rather than a run of events.
  for (let i = 0; i < 5; i += 1) {
    const ran = statusRuns();
    repositoryState.fire();
    await until(() => statusRuns() > ran, 5_000);
  }

  const answeredBy = Date.now() + 10_000;
  while (Date.now() < answeredBy && workspaceMemory.get('weft.statusAnswers') === undefined) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const offered = offers.slice(offersFrom);
  const kept = Object.values(workspaceMemory.get('weft.statusAnswers') ?? {});
  const gitSetting = (key) => {
    try {
      return runGit(repoPath, 'config', '--get', key).trim();
    } catch {
      return null;
    }
  };

  console.log('slow status    :', offered.length, 'offer(s)', JSON.stringify(offered[0]?.buttons ?? []), '| kept', JSON.stringify(kept));

  if (offered.length !== 1) {
    problems.push(`a run of slow git status reads made ${offered.length} offers, not one`);
  }

  if (!kept.includes('never')) {
    problems.push('"Never for This Repository" was not remembered');
  }

  if (gitSetting('core.untrackedCache') !== null || gitSetting('core.fsmonitor') !== null) {
    problems.push("answering Never changed git's settings anyway");
  }

  settings.delete('weft.statusSlowMs');

  // --- a repository appearing, which is what makes the sections show up ----------------------
  contextKeys.delete('weft.hasRepository');
  repositoryOpened.fire({
    rootUri: uri(repoPath.replace(/\\/g, '/')),
    state: { onDidChange: repositoryState.event },
  });

  const presenceBy = Date.now() + 10_000;
  while (Date.now() < presenceBy && !contextKeys.has('weft.hasRepository')) {
    await new Promise((r) => setTimeout(r, 25));
  }

  console.log('repo events    : hasRepository ->', contextKeys.get('weft.hasRepository'));

  if (contextKeys.get('weft.hasRepository') !== true) {
    problems.push('a repository opening did not put the Source Control sections back');
  }

  // --- a setting with a value ----------------------------------------------------------------
  const scheduled = intervals.length;

  settings.set('weft.autoFetchMinutes', 5);
  configurationChanged.fire(['weft.autoFetchMinutes']);
  await until(() => intervals.length > scheduled);

  const timer = intervals[intervals.length - 1];
  console.log('auto-fetch     :', intervals.length > scheduled ? `every ${timer.ms} ms` : 'NOT SCHEDULED');

  if (intervals.length === scheduled) {
    problems.push('turning auto-fetch on scheduled nothing');
  } else if (timer.ms !== 5 * 60_000) {
    problems.push(`auto-fetch asked for 5 minutes and scheduled ${timer.ms} ms`);
  }

  settings.set('weft.autoFetchMinutes', 0);
  configurationChanged.fire(['weft.autoFetchMinutes']);
  // Nothing being scheduled leaves nothing to poll for: the list stays the length it was, and only
  // time passing says it stayed that way on purpose.
  await quiet();

  if (intervals.length > scheduled + 1) {
    problems.push('turning auto-fetch off scheduled another one');
  }

  // The status bar has a switch too, and its off position had never been taken.
  settings.set('weft.statusBar.enabled', false);
  configurationChanged.fire(['weft.statusBar.enabled']);

  const hiddenBy = Date.now() + 10_000;
  while (Date.now() < hiddenBy && statusBarItem?.visible !== false) {
    await new Promise((r) => setTimeout(r, 25));
  }

  console.log('status bar off :', statusBarItem?.visible === false ? 'hidden' : 'STILL SHOWING');

  if (statusBarItem?.visible !== false) {
    problems.push('turning the status bar item off left it on screen');
  }

  settings.set('weft.statusBar.enabled', true);
  configurationChanged.fire(['weft.statusBar.enabled']);

  if (!(await until(() => statusBarItem?.visible === true))) {
    problems.push('turning the status bar item back on left it hidden');
  }
}

/*
 * weft.ticketLinks: what cannot be used is said out loud and said once, and what can reaches every open
 * graph without a walk.
 *
 * Both of these were silent. A pattern that is not a regular expression and a url that is not http are
 * the two mistakes the settings editor cannot catch, and they used to be dropped without a word; and the
 * patterns only ever reached a view inside `init`, so correcting one changed nothing anybody could see
 * until a ref moved.
 */
{
  const saidBefore = confirmations.length;
  const postedBefore = posted.length;
  const patternsPosted = () => posted.slice(postedBefore).filter((m) => m.type === 'ticketPatterns');

  settings.set('weft.ticketLinks', [
    { pattern: 'ERP-[0-9]+', url: 'https://tracker.example/browse/$0' },
    { pattern: '([', url: 'https://tracker.example/$0' },
    { pattern: 'CALC-[0-9]+', url: 'file:///C:/Windows/System32/calc.exe' },
  ]);
  configurationChanged.fire(['weft.ticketLinks']);

  const heard = await until(() => confirmations.length > saidBefore && patternsPosted().length > 0);
  const said = confirmations
    .slice(saidBefore)
    .map((c) => c.message)
    .join(' | ');

  console.log('\nticket links   :', heard ? said : 'NOTHING SAID');

  if (!heard) {
    problems.push('a weft.ticketLinks entry that cannot be used was dropped without a word');
  } else if (!said.includes('weft.ticketLinks') || !said.includes('2 entries')) {
    problems.push(`the warning did not say what could not be used: ${said}`);
  }

  const sent = patternsPosted().at(-1)?.patterns ?? [];

  if (JSON.stringify(sent) !== JSON.stringify(['ERP-[0-9]+'])) {
    problems.push(`the graph was sent ${JSON.stringify(sent)} rather than the one link that can be used`);
  }

  // Said once: the same setting saved again is not a second mistake, and this event fires for more than an edit.
  const saidOnce = confirmations.length;

  configurationChanged.fire(['weft.ticketLinks']);
  await quiet();

  if (confirmations.length > saidOnce) {
    problems.push('the same weft.ticketLinks mistake was reported twice');
  }

  // Corrected: nothing to say, and the graph is told without being walked again.
  const walksBefore = posted.filter((m) => m.type === 'done').length;
  const correctedFrom = posted.length;

  settings.set('weft.ticketLinks', [{ pattern: 'BUG-[0-9]+', url: 'https://tracker.example/$0' }]);
  configurationChanged.fire(['weft.ticketLinks']);

  if (!(await until(() => posted.slice(correctedFrom).some((m) => m.type === 'ticketPatterns')))) {
    problems.push('a corrected weft.ticketLinks never reached the graph');
  }

  const corrected = posted.slice(correctedFrom).filter((m) => m.type === 'ticketPatterns').at(-1)?.patterns ?? [];

  if (JSON.stringify(corrected) !== JSON.stringify(['BUG-[0-9]+'])) {
    problems.push(`the corrected setting sent ${JSON.stringify(corrected)}`);
  }

  if (confirmations.length > saidOnce) {
    problems.push('a weft.ticketLinks that can be used was complained about');
  }

  if (posted.filter((m) => m.type === 'done').length > walksBefore) {
    problems.push('changing weft.ticketLinks walked the history again');
  }

  settings.delete('weft.ticketLinks');
  configurationChanged.fire(['weft.ticketLinks']);
}

/*
 * Clean Up Merged Branches, end to end: the merged ones offered ticked and oldest first, a protected
 * branch and HEAD's never offered, what was picked deleted, and every tip in the log before it went.
 */
{
  /*
   * Tips a day apart, both in main, so oldest first has something to go by. The commits this run has
   * made were all made within a second or two, and branches whose tips are equally old keep git's order,
   * which is by name - swept_new before swept_old. main moves onto the two for the clean-up, its tree
   * unchanged, and back to where it was afterwards.
   */
  const mainWas = runGit(repoPath, 'rev-parse', 'main').trim();
  const mainAt = Number(runGit(repoPath, 'log', '-1', '--format=%ct', 'main').trim());
  const olderTip = runGitAt(repoPath, `${mainAt + 3600} +0000`, 'commit-tree', 'main^{tree}', '-p', mainWas, '-m', 'swept, the older').trim();
  const newerTip = runGitAt(repoPath, `${mainAt + 86400} +0000`, 'commit-tree', 'main^{tree}', '-p', olderTip, '-m', 'swept, the newer').trim();

  runGit(repoPath, 'update-ref', 'refs/heads/main', newerTip);
  runGit(repoPath, 'branch', 'swept_old', olderTip);
  runGit(repoPath, 'branch', 'swept_new', newerTip);
  runGit(repoPath, 'branch', 'release/kept', 'main');

  confirmed = true;
  pickAnswers.push(['swept_old', 'swept_new']);
  await commands.get('weft.cleanUpBranches')();

  const by = Date.now() + 15_000;
  while (Date.now() < by && runGit(repoPath, 'branch', '--list', 'swept_old', 'swept_new').trim() !== '') {
    await new Promise((r) => setTimeout(r, 50));
  }

  // The tips are written to the log before the branches go, so by now they are there - unless the
  // clean-up deleted without writing them, which is what the count below is about.
  const tips = () => outputLines.filter((line) => line.startsWith('info') && line.includes('clean-up: swept_'));
  await until(() => tips().length >= 2);

  const offer = picks.at(-1);
  const ticked = offer?.ticked ?? [];
  const left = runGit(repoPath, 'branch', '--list', 'swept_old', 'swept_new', 'release/kept').trim();
  const logged = tips();

  console.log('\nclean up       :', JSON.stringify(ticked), '| left', JSON.stringify(left), '|', logged.length, 'tips logged');

  if (ticked.indexOf('swept_old') < 0 || ticked.indexOf('swept_new') < ticked.indexOf('swept_old')) {
    problems.push('the clean-up did not offer the merged branches ticked, oldest first: ' + JSON.stringify(ticked));
  }

  if ((offer?.labels ?? []).some((label) => label === 'release/kept' || label === 'main')) {
    problems.push('the clean-up offered a protected branch, or the one HEAD is on: ' + JSON.stringify(offer?.labels));
  }

  if (left !== 'release/kept') {
    problems.push('after the clean-up, git still has ' + JSON.stringify(left));
  }

  if (logged.length < 2) {
    problems.push('the clean-up deleted branches without writing their tips to the log first');
  }

  const restoredFrom = posted.filter((m) => m.type === 'done').length;

  runGit(repoPath, 'branch', '-D', 'release/kept');
  runGit(repoPath, 'update-ref', 'refs/heads/main', mainWas);

  // Until the graph has walked main where it was put back, so the sections below are not reading a
  // repository the extension has yet to catch up with. Capped short and unasserted, because nothing
  // here is about the reload - the fixed wait it replaces made no promise about one either.
  await until(() => posted.filter((m) => m.type === 'done').length > restoredFrom, 5_000);
}

/*
 * A lock file git left behind is named, with how to be rid of it.
 *
 * A config.lock stayed in a repository for eight months after a command stopped part-way, and every write
 * to git's settings failed on it - which Weft called another git process using the repository, to be
 * waited for. Nothing was running, and the wait had no end. A rename writes the config as well as the
 * ref, so it meets a lock left two days ago: the warning has to say which file, and that deleting it is
 * the fix, and the lock has to be there still - Weft deletes nothing under .git by itself.
 */
{
  const configLock = join(repoPath, '.git', 'config.lock');
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);

  runGit(repoPath, 'branch', 'lockbound', 'main');
  writeFileSync(configLock, readFileSync(join(repoPath, '.git', 'config')));
  utimesSync(configLock, twoDaysAgo, twoDaysAgo);

  confirmed = true;
  inputAnswers.push('lockbound-renamed');
  const warnedFrom = confirmations.length;

  await messageHandler({
    type: 'runAction',
    id: 'weft.renameBranch',
    target: { kind: 'ref', refName: 'refs/heads/lockbound', label: 'lockbound', refKind: 'local' },
  });

  const warnedBy = Date.now() + 15_000;
  while (Date.now() < warnedBy && confirmations.length === warnedFrom) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const warned = confirmations
    .slice(warnedFrom)
    .map((entry) => entry.message)
    .join(' | ');
  const kept = existsSync(configLock);

  console.log('\nstale lock     :', JSON.stringify(warned.slice(0, 110)), '| the lock still there:', kept);

  if (!warned.includes('.git/config.lock') || !warned.includes('delete it')) {
    problems.push('an old config.lock was not named, with how to be rid of it: ' + JSON.stringify(warned));
  }

  if (!kept) {
    problems.push('Weft deleted a lock file under .git by itself');
  }

  rmSync(configLock, { force: true });

  // Renamed or not, depending on how far git got before the lock stopped it.
  const leftover = runGit(repoPath, 'branch', '--list', 'lockbound', 'lockbound-renamed')
    .split('\n')
    .map((line) => line.replace(/^[*+ ]+/, '').trim())
    .filter((line) => line.length > 0);

  if (leftover.length > 0) {
    runGit(repoPath, 'branch', '-D', ...leftover);

    // Until the sidebar has stopped listing what the lock left behind: the section below reads that
    // tree, and a row for a branch that no longer exists is one it could pick.
    const tree = treeProviders.get('weft.refs');
    const heads = () => tree.getChildren(tree.getChildren().find((g) => g.id === 'heads'));

    await until(() => !heads().some((node) => String(node.label).startsWith('lockbound')), 10_000);
  }
}

/*
 * Deleting a branch from the tree, end to end.
 *
 * Not "the action works" - `write.test.ts` covers that against real repositories. What is covered
 * here is the wiring either side of it: that a tree node reaches the right action through the
 * panel, and that the two places showing the branch agree afterwards. A delete that removes the ref
 * and leaves it listed is indistinguishable, from the outside, from a delete that did nothing.
 */
{
  const refsProvider = treeProviders.get('weft.refs');
  const heads = () =>
    refsProvider.getChildren(refsProvider.getChildren().find((g) => g.id === 'heads'));

  const victim = heads().find((node) => node.label === 'side');
  const before = confirmations.length;
  const said = statusMessages.length;

  if (victim === undefined) {
    problems.push('no branch to delete from the tree');
  } else {
    await commands.get('weft.deleteRef')(victim);

    await until(() => confirmations.length > before);

    // Until the delete has said its piece and the row has gone: the status line comes after the ref
    // does, and the sidebar losing the row is the half that used to be missed.
    await until(() => statusMessages.length > said && !heads().some((node) => node.label === 'side'));

    const asked = confirmations.at(-1);
    const inGit = runGit(repoPath, 'branch', '--list', 'side').trim();
    const listed = heads().some((node) => node.label === 'side');

    console.log('\ndelete branch  :', JSON.stringify(asked?.message ?? '(never asked)'));
    console.log('  git has it   :', inGit.length > 0 ? inGit : 'no');
    console.log('  tree lists it:', listed);

    // One "(was …)": the branch's own. HEAD did not move, so a second one would be the panel adding
    // where HEAD already is as if it were a way back.
    const deletedSaid = statusMessages.at(-1) ?? '';
    const suffixes = (deletedSaid.match(/\(was /g) ?? []).length;
    console.log('  status line  :', JSON.stringify(deletedSaid));

    if (suffixes !== 1) {
      problems.push(`the delete's status line says "(was" ${suffixes} times: ${deletedSaid}`);
    }

    if (asked === undefined) {
      problems.push('deleting a branch from the tree never asked for confirmation');
    }

    if (inGit.length > 0) {
      problems.push('confirming the delete left the branch in git');
    }

    // The half that is easy to miss: the ref is gone and the sidebar still shows it, which reads
    // as the delete having done nothing at all.
    if (listed) {
      problems.push('the branch was deleted but Branches & Tags still lists it');
    }
  }
}

/*
 * The statistics tab, which counts the graph's own walk rather than walking again.
 *
 * So what it says has to be what the graph walked: the graph's total, with every commit on one bar. A new
 * walk has to reach it without anybody asking, and a group made in Authors has to fold the walk it already
 * has again, not walk the history a second time to say the same thing. Here, before the graph closes: a
 * tab with no graph has nothing to count, and that is checked where it closes.
 */
{
  await commands.get('weft.showStatistics')();
  const stats = otherPanels.find((panel) => panel.viewType === 'weft.stats');

  if (stats === undefined) {
    problems.push('Show Statistics opened no statistics tab');
  } else {
    /*
     * What its page loads has to be in the package. `.vscodeignore` leaves all of dist/ out and names what
     * goes back in, so a script not named there is a page that loads nothing - and only once installed.
     */
    const shipped = readFileSync(new URL('../.vscodeignore', import.meta.url), 'utf8').split(/\r?\n/);
    const loads = [
      ...new Set(
        [panelObject?.webview.html ?? '', stats.html].flatMap((html) =>
          [...html.matchAll(/\/dist\/([\w.-]+)"/g)].map((match) => match[1]),
        ),
      ),
    ];
    const unshipped = loads.filter((file) => !shipped.includes(`!dist/${file}`));

    console.log('');
    console.log('stats tab      :', stats.title, '| the pages load', loads.join(', '));

    if (!stats.html.includes('/dist/stats.js"')) {
      problems.push('the statistics tab does not load dist/stats.js');
    }

    if (unshipped.length > 0) {
      problems.push(`a page loads ${unshipped.join(', ')}, which .vscodeignore leaves out of the package`);
    }

    const summaries = (from = 0) => stats.posted.slice(from).filter((m) => m.type === 'summary');
    const addsUp = (summary) =>
      summary.perBucket.every(
        (count, bar) => summary.series.reduce((sum, band) => sum + band.counts[bar], 0) + summary.others[bar] === count,
      ) && summary.perBucket.reduce((sum, count) => sum + count, 0) + summary.undated === summary.total;

    stats.handler({ type: 'ready', includeMerges: false });
    await until(() => summaries().length > 0);

    const walked = posted.filter((m) => m.type === 'done').at(-1);
    const counted = summaries().at(-1)?.summary;

    console.log(
      '  counted      :',
      counted?.total,
      'commits and',
      counted?.merges,
      'merges |',
      counted?.people.map((person) => `${person.name} ${person.commits}`).join(', '),
      '| the graph walked',
      walked?.total,
    );

    if (counted === undefined) {
      problems.push('the statistics tab was sent nothing to draw');
    } else {
      // Merges are left out until asked for, and counted apart: between them, every commit the graph walked.
      if (counted.includeMerges !== false || counted.total + counted.merges !== walked?.total) {
        problems.push(
          `the statistics tab counted ${counted.total} commits and ${counted.merges} merges where the graph walked ${walked?.total}`,
        );
      }

      if (!addsUp(counted)) {
        problems.push("the statistics tab's bars do not add up to the commits they were cut from");
      }
    }

    // --- a new walk reaches the tab by itself: the graph capped at three --------------------------------

    const capFrom = stats.posted.length;

    settings.set('weft.maxCommits', 3);
    await messageHandler({ type: 'refresh' });
    await until(() => summaries(capFrom).length > 0);

    const sequence = stats.posted.slice(capFrom).map((m) => m.type);
    const capped = summaries(capFrom).at(-1)?.summary;

    console.log('  capped at 3  :', sequence.join(' -> '), '|', capped?.total, 'commits, truncated', capped?.truncated);

    if (sequence[0] !== 'walking') {
      problems.push(`a new walk reached the statistics tab as ${sequence.join(', ') || 'nothing'}, not walking first`);
    }

    if ((capped?.total ?? 0) + (capped?.merges ?? 0) !== 3 || capped?.truncated !== true) {
      problems.push(
        `a walk capped at 3 reached the statistics tab as ${capped?.total} commits, truncated ${capped?.truncated}`,
      );
    }

    const uncapFrom = stats.posted.length;

    settings.delete('weft.maxCommits');
    await messageHandler({ type: 'refresh' });
    await until(() => summaries(uncapFrom).length > 0);

    // --- merges counted when the switch is on, from the same walk, and walked for nothing ---------------

    const mergeFrom = stats.posted.length;
    const walksBeforeMerges = posted.filter((m) => m.type === 'done').length;
    const wholeWalk = posted.filter((m) => m.type === 'done').at(-1)?.total;

    stats.handler({ type: 'includeMerges', on: true });
    await until(() => summaries(mergeFrom).length > 0, 5_000);

    const withMerges = summaries(mergeFrom).at(-1)?.summary;

    console.log('  with merges  :', withMerges?.total, 'commits,', withMerges?.merges, 'merges among them');

    if (withMerges?.includeMerges !== true || withMerges.total !== wholeWalk || !addsUp(withMerges)) {
      problems.push(`with merges included the statistics tab counted ${withMerges?.total} where the graph walked ${wholeWalk}`);
    }

    // A page shown again says where its switch was left, and is counted that way from its first summary.
    const shownFrom = stats.posted.length;

    stats.handler({ type: 'ready', includeMerges: false });
    await until(() => summaries(shownFrom).length > 0, 5_000);

    const shown = summaries(shownFrom).at(-1)?.summary;

    if (shown?.includeMerges !== false) {
      problems.push('a page shown again with merges left out was counted with them in');
    }

    if (
      stats.posted.slice(mergeFrom).some((m) => m.type === 'walking') ||
      posted.filter((m) => m.type === 'done').length !== walksBeforeMerges
    ) {
      problems.push('counting merges the other way walked the history again');
    }

    // --- a rule of weft.statistics.excludeMessages: counted apart, and the graph walks as it did -----------

    const ruleFrom = stats.posted.length;
    const walksBeforeRule = posted.filter((m) => m.type === 'done').length;
    const graphBeforeRule = posted.filter((m) => m.type === 'done').at(-1)?.total;

    settings.set('weft.statistics.excludeMessages', ['^commit [0-9]+$', '[']);
    configurationChanged.fire(['weft.statistics.excludeMessages']);
    await until(
      () =>
        posted.filter((m) => m.type === 'done').length > walksBeforeRule &&
        summaries(ruleFrom).some((m) => (m.summary.excludeRules ?? []).length > 0),
    );

    // What the rule ought to have matched: the subjects that walk drew, in its pages from its reset to its end.
    const types = posted.map((m) => m.type);
    const doneAt = types.lastIndexOf('done');
    const resetAt = types.slice(0, doneAt).lastIndexOf('reset');
    const ruledWalk = posted[doneAt]?.total;
    const matchable = posted
      .slice(resetAt, doneAt)
      .filter((m) => m.type === 'page')
      .flatMap((m) => m.rows)
      .filter((row) => /^commit [0-9]+$/.test(row.subject)).length;
    const ruled = summaries(ruleFrom).at(-1)?.summary;

    console.log(
      '  a rule       :',
      ruled?.total,
      'counted,',
      ruled?.merges,
      'merges,',
      ruled?.excluded,
      'excluded of',
      matchable,
      'matching | set aside',
      JSON.stringify(ruled?.unreadableRules),
    );

    if (ruledWalk !== graphBeforeRule) {
      problems.push(`a statistics rule changed what the graph walks: ${graphBeforeRule} commits, then ${ruledWalk}`);
    }

    if (ruled === undefined || matchable === 0 || ruled.excluded !== matchable) {
      problems.push(`a rule matching ${matchable} subjects left ${ruled?.excluded} commits out of the statistics`);
    } else if (ruled.total + ruled.merges + ruled.excluded !== ruledWalk) {
      problems.push(
        `with a rule, ${ruled.total} counted, ${ruled.merges} merges and ${ruled.excluded} excluded are not the ${ruledWalk} walked`,
      );
    }

    if (JSON.stringify(ruled?.unreadableRules) !== '["["]') {
      problems.push(`a rule that is not a regular expression was not set aside: ${JSON.stringify(ruled?.unreadableRules)}`);
    }

    // And put back by the tab's own switch, from the same walk.
    const backFrom = stats.posted.length;
    const walksBeforeBack = posted.filter((m) => m.type === 'done').length;

    stats.handler({ type: 'includeExcluded', on: true });
    await until(() => summaries(backFrom).length > 0, 5_000);

    const putBack = summaries(backFrom).at(-1)?.summary;

    if (
      putBack?.includeExcluded !== true ||
      putBack.total + putBack.merges !== ruledWalk ||
      posted.filter((m) => m.type === 'done').length !== walksBeforeBack
    ) {
      problems.push(`putting the excluded commits back counted ${putBack?.total} of ${ruledWalk}, or walked again`);
    }

    stats.handler({ type: 'includeExcluded', on: false });

    // Unset again, and waited for until the tab has been told: otherwise the group below sees this walk as its own.
    const walksBeforeUnset = posted.filter((m) => m.type === 'done').length;
    const unsetFrom = stats.posted.length;

    settings.delete('weft.statistics.excludeMessages');
    configurationChanged.fire(['weft.statistics.excludeMessages']);
    await until(
      () =>
        posted.filter((m) => m.type === 'done').length > walksBeforeUnset &&
        summaries(unsetFrom).some((m) => (m.summary.excludeRules ?? []).length === 0),
    );

    // --- a group made in Authors folds the same walk again, and walks nothing ----------------------------

    const authorsProvider = treeProviders.get('weft.authors');
    const people = await authorsProvider.getChildren();

    if (people.length < 2) {
      problems.push('the fixture has too few authors to group for the statistics tab');
    } else {
      const spellings = people.slice(0, 2).flatMap((node) => authorsProvider.spellingsOf(node));
      const walks = posted.filter((m) => m.type === 'done').length;
      const foldFrom = stats.posted.length;

      authorsProvider.addToGroup(spellings, 'Both of Them');
      await until(() => summaries(foldFrom).length > 0, 5_000);
      // Long enough for a walk to have started, had the group asked for one - and a walk that is
      // never asked for posts nothing, so time passing is the only evidence there is.
      await quiet();

      const since = stats.posted.slice(foldFrom).map((m) => m.type);
      const folded = summaries(foldFrom).at(-1)?.summary;

      console.log(
        '  grouped      :',
        folded?.people.map((person) => `${person.name} ${person.commits}`).join(', '),
        '|',
        since.join(' -> '),
      );

      if (!folded?.people.some((person) => person.name === 'Both of Them' && person.custom)) {
        problems.push('a group made in Authors did not reach the statistics tab');
      }

      if (since.includes('walking') || posted.filter((m) => m.type === 'done').length !== walks) {
        problems.push('a group made in Authors walked the history again to refold the statistics');
      }

      authorsProvider.removeFromGroup(spellings, 'Both of Them');
    }
  }
}

/*
 * Closing the graph, which nothing here had ever done. Everything the panel holds is released in
 * one place - the watcher, the auto-fetch timer - and with no graph left to select in, the file
 * list is showing a commit nobody can point at.
 */
if (disposeHandler !== null) {
  const filesView = treeViews.get('weft.files');
  const filesProvider = treeProviders.get('weft.files');
  // A statistics tab left open has no walk to show any more, and has to say so rather than keep the last.
  const statsTab = otherPanels.find((panel) => panel.viewType === 'weft.stats');

  disposeHandler();

  // Until the file list has been emptied and the tab told - what releasing the panel is for.
  await until(
    () =>
      filesProvider?.getChildren().length === 0 &&
      (statsTab === undefined || statsTab.posted.at(-1)?.type === 'noGraph'),
  );

  console.log('panel closed   :', JSON.stringify(filesView?.message ?? ''), '|', filesProvider?.getChildren().length, 'files listed');

  const statsSays = statsTab?.posted.at(-1)?.type;

  console.log('  stats tab    :', statsSays ?? '(none open)');

  if (statsTab !== undefined && statsSays !== 'noGraph') {
    problems.push(`closing the graph left its statistics tab showing ${statsSays}`);
  }

  if (filesProvider?.getChildren().length !== 0) {
    problems.push('closing the last graph left files in the Commit Files section');
  }

  if (!String(filesView?.message ?? '').includes('Select a commit')) {
    problems.push(`closing the last graph left the section saying ${filesView?.message}`);
  }
} else {
  problems.push('the panel never registered a dispose handler');
}

/*
 * The ordering flag, all the way to git.
 *
 * The control changing a variable is not the feature; the walk being ordered differently is. So the
 * assertion reads the command log rather than any state the view holds - the one place that says
 * what git was actually asked for.
 */
{
  const walks = () => outputLines.filter((line) => line.startsWith('debug') && line.includes('log'));
  const before = walks().length;

  // Until the walk it sets off has finished, rather than for as long as one usually takes: the last
  // `git log` on the line is only the one this asked for once nothing is still running.
  const topoFrom = posted.filter((m) => m.type === 'done').length;

  await messageHandler({ type: 'order', order: 'topo' });
  await settle(topoFrom);

  const latest = walks().at(-1) ?? '';
  const asked = (latest.match(/--[a-z-]*order/g) ?? []).join(' ');

  console.log('\nordering       : topo ->', asked || '(none)');

  if (walks().length === before) {
    problems.push('changing the commit order did not run another walk');
  } else if (asked !== '--topo-order') {
    // One flag, not two. `--date-order --topo-order` happens to work because git takes the last,
    // which is a graph decided by argument order rather than by the user.
    problems.push(`the order was set to topo and git was asked for: ${asked || 'no order at all'}`);
  }

  // And back, so nothing after this reads a differently ordered history.
  const dateFrom = posted.filter((m) => m.type === 'done').length;

  await messageHandler({ type: 'order', order: 'date' });
  await settle(dateFrom);

  const back = walks().at(-1) ?? '';

  // Exactly one ordering flag, always. Two would leave git's last-wins rule deciding what the
  // graph looks like, which is a coin toss dressed as a default.
  const flags = (back.match(/--[a-z-]*order/g) ?? []).join(' ');
  console.log('back to date   :', flags || '(none)');

  if (flags !== '--date-order') {
    problems.push(`going back to the default walk asked git for: ${flags || 'no order at all'}`);
  }
}


/*
 * Committed text, for the two annotations that are about commits - and the editor told, the way VS
 * Code tells it when a file changes on disk: a new version of the document.
 *
 * The working-tree checks above leave f1.txt edited on disk, and both annotations blame the file as
 * it is on disk. They used to pass anyway, handed a blame made at activation, before the edit, and
 * kept for as long as the text's version stayed the same - which here it always did, since nothing is
 * typed into this editor. Blame is asked again when HEAD moves now, and a blame asked while the file
 * was edited said so: "You, uncommitted changes" - true of the file, and not what these checks are for.
 */
runGit(repoPath, 'checkout', '-q', '--', 'f1.txt');

const blamedFrom = decorations.length;

editorDocument.version += 1;
documentChanged.fire({ document: editorDocument, contentChanges: [] });

// Until the annotation has been drawn again for the file as it is now. Without this the checks below
// read the blame made while f1.txt was still edited, which says something true and beside the point.
const blamedAgain = () =>
  decorations
    .slice(blamedFrom)
    .flat()
    .some((entry) => (entry?.renderOptions?.after?.contentText ?? '').length > 0);

if (!(await until(blamedAgain))) {
  problems.push('a new version of the text drew no line-end blame for it');
}

/*
 * The line-end blame.
 *
 * It draws on a timer after activation and watches the window rather than the graph, so by now it
 * has had the whole run above to land. What it drew is the check: a decoration with nothing in it
 * is one nobody can read, and the annotation is the entire feature.
 */
{
  const drawn = decorations
    .flat()
    .map((entry) => entry?.renderOptions?.after?.contentText ?? '')
    .filter((text) => text.length > 0);

  const last = drawn[drawn.length - 1] ?? '';

  console.log('');
  console.log('inline blame   :', drawn.length === 0 ? 'NOTHING DRAWN' : JSON.stringify(last));

  if (drawn.length === 0) {
    problems.push('the line-end blame never drew anything for a line that has a commit behind it');
  } else if (!last.includes('ago') && !last.includes('just now')) {
    problems.push(`the line-end blame drew "${last}", which does not say when`);
  } else if (!last.includes('•')) {
    problems.push(`the line-end blame drew "${last}", which does not say what the commit was`);
  }

  /*
   * About its one line, not the file. Blaming every line of a file of thousands to annotate the one
   * the cursor is on was the question asked at its most expensive, again for each new version of the
   * text. The column, further down, is the thing that wants every line.
   */
  const blames = outputLines.filter((l) => l.startsWith('debug') && l.includes('git blame --porcelain'));
  const oneLine = blames.filter((l) => l.includes(' -L '));

  console.log('blame asked    :', blames.length, 'time(s),', oneLine.length, 'about one line');

  if (blames.length > 0 && oneLine.length !== blames.length) {
    problems.push(`the line-end blame blamed the whole file ${blames.length - oneLine.length} time(s) for one line`);
  }

  /*
   * And the way through to the graph.
   *
   * The link lives in the hover because a decoration's trailing text is drawn rather than built,
   * so there is nothing else to attach a click to - which makes "is it in the hover" the only
   * question worth asking about it.
   */
  const linked = decorations
    .flat()
    .map((entry) => entry?.hoverMessage?.value ?? '')
    .filter((value) => value.includes('command:weft.revealCommit'));

  console.log('blame hover    :', linked.length > 0 ? 'links into the graph' : 'NO LINK');

  if (drawn.length > 0 && linked.length === 0) {
    problems.push('the blame hover offers no way through to the graph');
  }

  const head = String(runGit(repoPath, 'rev-parse', 'HEAD')).trim();
  const before = posted.filter((m) => m.type === 'reveal').length;

  await commands.get('weft.revealCommit')({ sha: head, root: repoPath });
  await until(() => posted.filter((m) => m.type === 'reveal').length > before);

  const asked = posted.filter((m) => m.type === 'reveal');

  console.log(
    'reveal commit  :',
    asked.length > before ? asked[asked.length - 1].sha.slice(0, 8) : 'NOTHING SENT',
  );

  if (asked.length === before) {
    problems.push('Show in the graph did not reach the view');
  } else if (asked[asked.length - 1].sha !== head) {
    problems.push('Show in the graph asked the view for a different commit');
  }
}

/*
 * The whole-file column, which is the other annotation and the one nobody gets unasked.
 *
 * Told apart from the line-end one by which side of the text it attaches to: a column is drawn
 * `before`, the quiet one `after`. Both go through the same recorder, and needing to tell them
 * apart at all is the point - turning one on must not have turned the other off.
 *
 * The bar of heat beside the column is drawn `before` as well, and told apart from the column by what
 * it carries: the column has words, the bar has a colour and nothing else.
 */
{
  const columns = () =>
    decorations.flat().filter((entry) => entry?.renderOptions?.before?.contentText !== undefined);
  const bars = () =>
    decorations.flat().filter((entry) => entry?.renderOptions?.before?.backgroundColor !== undefined);

  const before = columns().length;

  await commands.get('weft.toggleFileBlame')();
  await until(() => columns().length > before);

  const drawn = columns();
  const text = drawn[drawn.length - 1]?.renderOptions?.before?.contentText ?? '';

  console.log('');
  console.log('file blame     :', drawn.length > before ? JSON.stringify(text) : 'NOTHING DRAWN');

  if (drawn.length === before) {
    problems.push('Toggle File Blame drew no column');
  } else if (!/\d{4}-\d{2}-\d{2}/.test(text)) {
    problems.push(`the file blame column drew "${text}", which does not say when`);
  }

  // The bar beside it: one for every line the blame has an answer for, in a colour the theme owns.
  const heat = bars();
  const colours = [...new Set(heat.map((entry) => entry.renderOptions.before.backgroundColor?.id))];

  console.log('blame heat     :', heat.length, 'bar(s) |', JSON.stringify(colours));

  if (heat.length === 0) {
    problems.push('the blame column was drawn with no bar of heat beside it');
  }

  if (colours.some((id) => !String(id).startsWith('charts.'))) {
    problems.push(`the heat was drawn in ${JSON.stringify(colours)}, which is not the theme's own`);
  }

  // Turned off, the column stays and the bar goes: a repaint draws no more of them.
  const columnsBefore = columns().length;

  settings.set('weft.blameHeatmap', false);
  configurationChanged.fire(['weft.blameHeatmap']);

  /*
   * Until the repaint the setting asks for has drawn its column. The bar is set in the statement
   * after the column's, so once the column is here the annotation has already decided about the bar
   * - which is what the count below reads.
   */
  await until(() => columns().length > columnsBefore);

  console.log('heat off       :', bars().length - heat.length, 'more bar(s) |', columns().length - columnsBefore, 'more column');

  if (bars().length !== heat.length) {
    problems.push(`with weft.blameHeatmap off the column drew ${bars().length - heat.length} more bars`);
  }

  if (columns().length === columnsBefore) {
    problems.push('turning the heat off took the blame column with it');
  }

  const barsOff = bars().length;

  settings.delete('weft.blameHeatmap');
  configurationChanged.fire(['weft.blameHeatmap']);

  // Until the heat is back, so that the repaint putting it there cannot land after the column is
  // taken away below and leave two decorations on the end that are not the two being read.
  if (!(await until(() => bars().length > barsOff))) {
    problems.push('putting weft.blameHeatmap back drew no heat beside the column again');
  }

  const cleanedFrom = decorations.length;

  await commands.get('weft.toggleFileBlame')();

  // Two decorations were put on, so two have to come off - waited for by their arriving rather than
  // by the clock, and read exactly as they were read before.
  await until(() => decorations.length >= cleanedFrom + 2);

  // Both the column and its bar: two decorations were put on, and two have to come off.
  const last = decorations.slice(-2);
  const cleared = last.length === 2 && last.every((entry) => Array.isArray(entry) && entry.length === 0);

  console.log('file blame off :', cleared ? 'cleared' : 'STILL THERE');

  if (!cleared) {
    problems.push('Toggle File Blame a second time did not take the column away');
  }
}

/*
 * The history of a few lines, in its own section.
 *
 * `git log -L` walks from exactly one commit - two refs are "More than one commit to dig from" -
 * so this can never be the graph's walk with a filter on it, and the ref list must never reach its
 * command line. Which is why it is a list beside the graph rather than a mode inside it, and why
 * the two are joined by a click rather than by state.
 */
{
  const provider = treeProviders.get('weft.lineHistory');

  if (provider === undefined) {
    problems.push('no line history section was contributed');
  } else {
    const empty = provider.getChildren();

    activeEditor.selection = { active: { line: 0 }, start: { line: 0 }, end: { line: 0 } };
    await commands.get('weft.showLineHistory')();

    const found = provider.getChildren();
    const first = found[0];

    console.log('');
    console.log(
      'line history   :',
      `${found.length} commits touched line 1 of f1.txt`,
      '| before asking:',
      empty.length,
    );

    if (empty.length !== 0) {
      problems.push('the line history section had commits in it before anybody asked');
    }

    if (found.length === 0) {
      problems.push('asking for the history of a line that has one came back empty');
    }

    if (contextKeys.get('weft.lineHistory') !== true) {
      problems.push('the line history section stayed hidden after it was asked a question');
    }

    if (first !== undefined) {
      const item = provider.getTreeItem(first);

      console.log('  row          :', `${item.label} — ${item.description}`);

      if (item.command?.command !== 'weft.revealCommit') {
        problems.push(`a line history row runs ${item.command?.command}, not weft.revealCommit`);
      }

      // The click, end to end: the graph has to answer with that commit and not another.
      const before = posted.filter((m) => m.type === 'reveal').length;
      await commands.get(item.command.command)(...item.command.arguments);

      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        posted.filter((m) => m.type === 'reveal').length === before
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const revealed = posted.filter((m) => m.type === 'reveal').pop();

      console.log('  clicked      :', revealed?.sha?.slice(0, 8), 'revealed in the graph');

      if (revealed?.sha !== first.sha) {
        problems.push(
          `clicking a line history row revealed ${revealed?.sha?.slice(0, 8)}, not ${first.sha.slice(0, 8)}`,
        );
      }
    }

    await commands.get('weft.clearLineHistory')();

    console.log('  closed       :', provider.getChildren().length, 'rows left');

    if (provider.getChildren().length !== 0) {
      problems.push('closing the line history section left its rows behind');
    }

    if (contextKeys.get('weft.lineHistory') !== false) {
      problems.push('closing the line history section left it on screen');
    }
  }
}

/*
 * A history that stopped early has to say so.
 *
 * `--max-count` stops git at N and exits 0, so a truncated walk is indistinguishable from a
 * complete one from the outside: the root commits are simply absent, lanes that would have closed
 * further back run off the bottom, and the line at the corner reports the limit as though it were
 * the size of the repository.
 */
{
  const walksBefore = posted.filter((m) => m.type === 'done').length;

  settings.set('weft.maxCommits', 3);
  await messageHandler({ type: 'refresh' });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length === walksBefore) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const capped = posted.filter((m) => m.type === 'done').pop();

  console.log('');
  console.log('capped at 3    :', capped?.total, 'commits | truncated:', capped?.truncated);

  if (capped?.total !== 3) {
    problems.push(`a walk capped at 3 returned ${capped?.total} commits`);
  }

  if (capped?.truncated !== true) {
    problems.push('a walk that stopped at the limit did not say so');
  }

  const before = posted.filter((m) => m.type === 'done').length;

  settings.delete('weft.maxCommits');
  await messageHandler({ type: 'refresh' });

  const whole = Date.now() + 20_000;
  while (Date.now() < whole && posted.filter((m) => m.type === 'done').length === before) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const full = posted.filter((m) => m.type === 'done').pop();

  console.log('uncapped       :', full?.total, 'commits | truncated:', full?.truncated);

  if (full?.truncated !== false) {
    problems.push('a walk that reached the end of the history claimed it was cut short');
  }
}

/*
 * Blame is current after a commit - and asks again only when HEAD moves.
 *
 * It was kept per version of the text, and a commit changes no text, so a line that had just been
 * committed went on being blamed as it was until the file was edited. The git extension reports
 * every file saved as well, and those change no answer: they must not cost a blame.
 */
{
  const lineSays = () =>
    decorations
      .flat()
      .map((entry) => entry?.renderOptions?.after?.contentText ?? '')
      .filter((text) => text.length > 0)
      .pop() ?? '';
  const blamesRun = () => outputLines.filter((l) => l.startsWith('debug') && l.includes('git blame --porcelain')).length;

  // Reports that move nothing: no HEAD change, so no blame. A blame that is never asked for runs no
  // command to wait for, so this one stays a wait - long enough that one on its way would have run.
  const quietFrom = blamesRun();
  repositoryState.fire();
  repositoryState.fire();
  await quiet();
  const ranAnyway = blamesRun() - quietFrom;

  writeFileSync(join(repoPath, 'f1.txt'), 'changed where the cursor is\n');
  runGit(repoPath, 'commit', '-qam', 'the commit blame should name');
  repositoryState.fire();

  const by = Date.now() + 10_000;
  while (Date.now() < by && !lineSays().includes('the commit blame should name')) {
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('\nblame on HEAD  :', ranAnyway, 'blame(s) for reports that moved nothing | after a commit', JSON.stringify(lineSays()));

  if (ranAnyway !== 0) {
    problems.push('a report from the git extension that moved nothing ran blame ' + ranAnyway + ' time(s)');
  }

  if (!lineSays().includes('the commit blame should name')) {
    problems.push('after a commit the line-end blame still said ' + JSON.stringify(lineSays()));
  }
}

/*
 * The cursor moving within one line repaints nothing.
 *
 * Every cursor event redrew both annotations to draw what was already there - and with the column
 * on, that is a decoration for every line of the file, for each move of the cursor.
 */
{
  // Quiet before the count starts, so that a repaint the commit above set off is not read as one of
  // the cursor's - and quiet after each event and at the end, because a repaint that never happens
  // is the whole assertion and has nothing to poll for.
  await quiet();
  const paintedFrom = decorations.length;

  for (let i = 0; i < 3; i += 1) {
    selectionChanged.fire({ textEditor: activeEditor, selections: [activeEditor.selection] });
    // Three separate events, spaced as they were: fired back to back they could be coalesced, and a
    // repaint that was coalesced away is not a repaint that never happened.
    await quiet(400);
  }

  await quiet();

  const repainted = decorations.length - paintedFrom;
  console.log('same line      :', repainted, 'repaint(s) for 3 cursor events on one line');

  if (repainted !== 0) {
    problems.push('the cursor moving within one line repainted the blame ' + repainted + ' time(s)');
  }
}

/*
 * Ticket ids as links. The view sends the text that was clicked and nothing else: the host matches it
 * whole against weft.ticketLinks, fills the address in itself, and opens only http and https.
 */
{
  settings.set('weft.ticketLinks', [
    { pattern: 'ERP-[0-9]+', url: 'https://tracker.example/browse/$0' },
    { pattern: 'EVIL-[0-9]+', url: 'file:///C:/Windows/System32/calc.exe?$0' },
  ]);
  opened.length = 0;

  for (const text of ['ERP-10147', 'see ERP-10147', 'EVIL-1', 'ERP-1/../../x']) {
    await messageHandler({ type: 'openTicket', text });
  }

  console.log('\nticket links   :', JSON.stringify(opened));

  if (JSON.stringify(opened) !== JSON.stringify(['https://tracker.example/browse/ERP-10147'])) {
    problems.push('opening ticket ids opened ' + JSON.stringify(opened) + ', not the one tracker address');
  }

  settings.delete('weft.ticketLinks');
}

/*
 * Open on the web, through the panel. A server nothing identifies is refused with the setting that
 * names it, and the refusal walks nothing - nothing moved; named there, the commit opens at the address
 * its server gives it, handed to VS Code as it is spelled.
 */
{
  runGit(repoPath, 'remote', 'add', 'origin', 'http://10.20.30.40/erp/dlp.git');
  runGit(repoPath, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // Said outright, so no provider configured on the machine running this can answer for it.
  runGit(repoPath, 'config', 'credential.http://10.20.30.40.provider', 'generic');

  const head = String(runGit(repoPath, 'rev-parse', 'HEAD')).trim();
  const commit = { kind: 'commit', sha: head, subject: 'the commit' };
  const refsProvider = treeProviders.get('weft.refs');

  /*
   * A remote arriving is refs arriving: until the sidebar has heard of origin/main, and then a
   * moment more, because whatever that set walking has to be over before the walks are counted -
   * and a walk that is finishing has nothing left to post.
   */
  await until(() => refsProvider.listRefs().some((ref) => ref.refName === 'refs/remotes/origin/main'));
  await quiet();

  opened.length = 0;
  const mark = posted.length;

  await messageHandler({ type: 'runAction', id: 'weft.openOnWeb', target: commit });

  if (!(await until(() => posted.slice(mark).some((m) => m.type === 'error'), 10_000))) {
    problems.push('opening a commit on a server nothing identifies was neither refused nor opened');
  }

  // And nothing after the refusal: "the refusal walks nothing" is an absence, so it is waited out.
  await quiet(1000);

  const refusal = posted.slice(mark).find((m) => m.type === 'error');
  const walked = posted.slice(mark).some((m) => m.type === 'reset');

  settings.set('weft.remoteHosts', { '10.20.30.40': 'gitlab' });
  await messageHandler({ type: 'runAction', id: 'weft.openOnWeb', target: commit });
  await until(() => opened.length > 0, 10_000);

  console.log('\nopen on web    :', JSON.stringify(refusal?.message ?? '(not refused)'), '|', JSON.stringify(opened));

  if (refusal === undefined || !refusal.message.includes('weft.remoteHosts')) {
    problems.push('a server nothing identifies was not refused with the setting that names it');
  }

  if (walked) {
    problems.push('refusing to open a commit on the web walked the graph again');
  }

  if (JSON.stringify(opened) !== JSON.stringify([`http://10.20.30.40/erp/dlp/-/commit/${head}`])) {
    problems.push('opening a commit on the web opened ' + JSON.stringify(opened));
  }

  /*
   * A file's link, from a file rather than from the graph: the same address with the file on the end,
   * pinned to the commit it is at. Copied and opened are the same link, and neither needs a panel.
   */
  copied.length = 0;
  opened.length = 0;

  // A file no editor is showing: the address of the file, and nothing about lines.
  await commands.get('weft.copyFileWebLink')(uri(`${repoPath}/f2.txt`));
  await commands.get('weft.openFileOnWeb')(uri(`${repoPath}/f2.txt`));

  // And the file the editor has open, where the line the cursor is on goes on the end of the address.
  await commands.get('weft.copyFileWebLink')(editorDocument.uri);

  const fileLink = `http://10.20.30.40/erp/dlp/-/blob/${head}/f2.txt`;
  const lineLink = `http://10.20.30.40/erp/dlp/-/blob/${head}/f1.txt#L1`;

  console.log('file links     :', JSON.stringify(copied), '|', JSON.stringify(opened));

  if (JSON.stringify(copied) !== JSON.stringify([fileLink, lineLink])) {
    problems.push(`copying a file's link copied ${JSON.stringify(copied)}, not ${fileLink} and ${lineLink}`);
  }

  if (JSON.stringify(opened) !== JSON.stringify([fileLink])) {
    problems.push(`opening a file on the web opened ${JSON.stringify(opened)}, not ${fileLink}`);
  }

  settings.delete('weft.remoteHosts');
  runGit(repoPath, 'config', '--unset', 'credential.http://10.20.30.40.provider');
  runGit(repoPath, 'remote', 'remove', 'origin');

  // Until the remote has left the sidebar again, so the sections below read the refs this run made
  // and not a remote branch that no longer exists.
  await until(() => !refsProvider.listRefs().some((ref) => ref.refName.startsWith('refs/remotes/origin/')), 10_000);
}

/*
 * The line above a file: who last changed it and how long ago, from one `git log -1`, pointing at that
 * file's history. And the setting that takes it away, which has to be read every time rather than once.
 */
{
  const lens = codeLensProviders[0];
  const document = { uri: uri(`${repoPath}/f1.txt`), version: 1 };
  const who = String(runGit(repoPath, 'log', '-1', '--format=%aN', '--', 'f1.txt')).trim();
  const lenses = lens === undefined ? [] : await lens.provider.provideCodeLenses(document, {});
  const said = lenses[0]?.command?.title ?? '';
  const runs = lenses[0]?.command?.command ?? '';

  settings.set('weft.codeLens', false);
  configurationChanged.fire(['weft.codeLens']);

  const off = lens === undefined ? [] : await lens.provider.provideCodeLenses(document, {});

  settings.delete('weft.codeLens');
  configurationChanged.fire(['weft.codeLens']);

  console.log('\ncode lens      :', JSON.stringify(said), '->', runs, '| with it off:', off.length);

  if (lens?.selector?.scheme !== 'file') {
    problems.push(`the code lens was offered for ${JSON.stringify(lens?.selector)}, not for files`);
  }

  if (!said.startsWith(`${who},`) || said.length <= who.length + 1) {
    problems.push(`the line above a file said ${JSON.stringify(said)}, and ${who} last changed it`);
  }

  if (runs !== 'weft.showFileHistory') {
    problems.push(`clicking the line above a file runs ${runs}, not that file's history`);
  }

  if (off.length !== 0) {
    problems.push(`with weft.codeLens off a file still had ${off.length} of them`);
  }

  /*
   * What it holds, and for how long. Three answers that used to be kept longer than they were true: a
   * commit anywhere threw away every repository's, a file nobody has open kept its own for the session,
   * and "this directory is not a repository" was kept even after `git init` made it one.
   */
  const asked = (path) => outputLines.filter((line) => line.startsWith('debug') && line.includes(`log -1 --format=%H`) && line.includes(path)).length;
  const elsewhere = makeTempRepo();
  const theirs = { uri: uri(`${elsewhere}/f1.txt`), version: 1 };

  await lens.provider.provideCodeLenses(theirs, {});

  const mineBefore = asked('f1.txt');
  const theirsBefore = asked(elsewhere.replace(/\\/g, '/'));

  // A commit here, which the git extension reports the way it reports every HEAD move.
  runGit(repoPath, 'commit', '-q', '--allow-empty', '-m', 'a commit the lens has to notice');
  repositoryState.fire();
  await quiet(300);

  await lens.provider.provideCodeLenses(document, {});
  await lens.provider.provideCodeLenses(theirs, {});

  const mineAfter = asked('f1.txt');
  const theirsAfter = asked(elsewhere.replace(/\\/g, '/'));

  console.log(
    'lens holds     : this repository asked',
    mineAfter - mineBefore,
    'more time(s) after its commit, another repository',
    theirsAfter - theirsBefore,
  );

  if (mineAfter === mineBefore) {
    problems.push('a commit in this repository left the line above its files saying what it said before');
  }

  if (theirsAfter !== theirsBefore) {
    problems.push(`a commit in one repository threw away another repository's lines, re-reading ${theirsAfter - theirsBefore}`);
  }

  // A file that was closed: nothing is held for it, so the next ask is a fresh one.
  const closedFrom = asked('f1.txt');

  documentClosed.fire(document);
  await lens.provider.provideCodeLenses(document, {});

  if (asked('f1.txt') === closedFrom) {
    problems.push('a file that was closed kept its line, so nothing is ever let go of');
  }

  // And a directory that becomes a repository after it was first asked about.
  const later = mkdtempSync(join(tmpdir(), 'weft-later-')).replace(/\\/g, '/');
  const laterFile = `${later}/f1.txt`;

  writeFileSync(laterFile, 'not in a repository yet\n');

  const beforeInit = await lens.provider.provideCodeLenses({ uri: uri(laterFile), version: 1 }, {});

  runGit(later, 'init', '-q', '-b', 'main');
  runGit(later, 'config', 'user.name', 'Weft Test');
  runGit(later, 'config', 'user.email', 'test@example.invalid');
  runGit(later, 'add', '-A');
  runGit(later, 'commit', '-q', '-m', 'now it is one');

  const afterInit = await lens.provider.provideCodeLenses({ uri: uri(laterFile), version: 1 }, {});

  console.log('after git init :', beforeInit.length, 'lens before,', afterInit.length, 'after');

  if (beforeInit.length !== 0 || afterInit.length !== 1) {
    problems.push(`a directory that became a repository had ${beforeInit.length} lines before and ${afterInit.length} after`);
  }
}

/*
 * A commit id printed in a terminal. The provider is asked for a line the way a terminal asks - text and
 * the terminal it was drawn in, nothing else - and clicking what it hands back has to reach the graph
 * with the whole id, from the short one that was printed.
 */
{
  const provider = terminalProviders[0];
  const head = String(runGit(repoPath, 'rev-parse', 'HEAD')).trim();

  /*
   * A short id with a letter in it, found rather than assumed. An id of nothing but digits is a number
   * as far as a terminal is concerned and is deliberately not linked - and roughly one fixture in forty
   * has eight digits at the front of HEAD, which made this check fail for exactly the right reason at
   * random. The rule itself is worth a line of its own below.
   */
  let short = head.slice(0, 8);

  for (let length = 9; length <= head.length && !/[a-f]/.test(short); length++) {
    short = head.slice(0, length);
  }

  const line = `[main ${short}] the commit somebody made in a terminal`;
  const links = provider === undefined ? [] : await provider.provideTerminalLinks({ line, terminal: { creationOptions: { cwd: repoPath } } }, {});
  const said = links.map((link) => line.slice(link.startIndex, link.startIndex + link.length));
  const mark = posted.length;

  if (said.length === 1 && said[0] === short) {
    await provider.handleTerminalLink(links[0]);
  }

  const revealed = posted.slice(mark).find((m) => m.type === 'reveal');

  console.log('\nterminal links :', JSON.stringify(said), '->', revealed?.sha ?? '(nothing revealed)');

  if (said.length !== 1 || said[0] !== short) {
    problems.push(`a commit id in a terminal line was read as ${JSON.stringify(said)}, not ${short}`);
  }

  if (revealed?.sha !== head) {
    problems.push(`clicking a commit id in a terminal revealed ${revealed?.sha}, not the whole ${head}`);
  }

  // The other half of the rule, where it reaches a terminal: eight digits are a build number, not an id.
  const digits = provider === undefined ? [] : await provider.provideTerminalLinks({ line: 'Build 20260916 finished', terminal: {} }, {});

  console.log('a number        :', digits.length === 0 ? 'left alone' : 'LINKED');

  if (digits.length !== 0) {
    problems.push(`a line saying "Build 20260916 finished" was given ${digits.length} link(s)`);
  }
}

/*
 * The editor that opens instead of git-rebase-todo, driven the way VS Code drives a custom editor: a
 * document, a panel, and the messages its page sends. What has to hold is that the file is the truth -
 * every change is in it straight away - and that the lines git put there which are not commits survive
 * a list that knows nothing about them.
 */
{
  const editor = customEditors.find((entry) => entry.viewType === 'weft.rebaseTodo');
  const shas = String(runGit(repoPath, 'log', '--format=%h', '-2')).trim().split('\n');
  const todoPath = `${repoPath}/.git/rebase-merge/git-rebase-todo`;
  const comments = '\n# Rebase 0123456..9999999 onto 0123456 (2 commands)\n#\n# p, pick <commit> = use commit\n';
  let text = `pick ${shas[0]} the newest\npick ${shas[1]} the one before it\nexec make test\n${comments}`;
  let saves = 0;
  let closed = 0;

  const document = {
    uri: uri(todoPath),
    getText: () => text,
    setText: (next) => void (text = next),
    positionAt: (offset) => ({ offset }),
    save: async () => {
      saves += 1;
      return !refuseSave;
    },
  };

  editableDocuments.set(todoPath, document);
  setRefusingEdits(() => refuseEdits);

  const sent = [];
  let handler = null;
  let refuseEdits = false;
  let refuseSave = false;
  const panel = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://weft',
      asWebviewUri: (value) => value,
      postMessage: async (message) => void sent.push(message),
      onDidReceiveMessage: (fn) => {
        handler = fn;
        return { dispose() {} };
      },
    },
    onDidDispose: () => ({ dispose() {} }),
    dispose: () => void (closed += 1),
  };

  if (editor === undefined) {
    problems.push('no editor was registered for git-rebase-todo');
  } else {
    editor.provider.resolveCustomTextEditor(document, panel);
    handler({ type: 'ready' });
    await until(() => sent.length > 0);

    const drawn = sent.at(-1);
    const subjects = (drawn?.rows ?? []).map((row) => `${row.action} ${row.sha} ${row.subject} (${row.author})`);

    console.log('');
    console.log('rebase editor  :', JSON.stringify(drawn?.summary ?? ''), '|', JSON.stringify(subjects));

    if (!panel.webview.html.includes('/dist/rebase.js')) {
      problems.push('the rebase editor does not load dist/rebase.js');
    }

    // Two commits, in the file's order, with what the file could not say filled in from the repository.
    if (drawn?.rows.length !== 2 || drawn.rows.some((row) => row.author === '' || row.subject === '')) {
      problems.push(`the rebase editor drew ${JSON.stringify(drawn?.rows ?? [])}`);
    }

    if (drawn?.summary !== '2 commits' || !String(drawn.onto).startsWith('Rebase ')) {
      problems.push(`the rebase editor said ${JSON.stringify(drawn?.summary)} of ${JSON.stringify(drawn?.onto)}`);
    }

    // An action changes the file, and the file changing is what redraws the list.
    const beforeAction = sent.length;

    handler({ type: 'action', at: 1, action: 'fixup' });
    await until(() => sent.length > beforeAction);

    const squashed = sent.at(-1);

    console.log('after fixup    :', JSON.stringify(text.split('\n').slice(0, 3)), '|', JSON.stringify(squashed?.summary));

    if (!text.startsWith(`pick ${shas[0]} the newest\nfixup ${shas[1]}`)) {
      problems.push(`changing an action wrote ${JSON.stringify(text.split('\n')[1] ?? '')}`);
    }

    if (squashed?.summary !== '1 commit, 1 squashed into the one before') {
      problems.push(`with a fixup in it the editor said ${JSON.stringify(squashed?.summary)}`);
    }

    // Moving one moves it among the commits: the exec line and the comments stay where they were.
    const beforeMove = sent.length;

    handler({ type: 'move', at: 1, by: -1 });
    await until(() => sent.length > beforeMove);

    const lines = text.split('\n');

    console.log('after move     :', JSON.stringify(lines.slice(0, 3)));

    if (!lines[0]?.startsWith('fixup ') || !lines[1]?.startsWith('pick ')) {
      problems.push(`moving a commit left the file as ${JSON.stringify(lines.slice(0, 2))}`);
    }

    if (lines[2] !== 'exec make test' || !text.includes('# p, pick <commit> = use commit')) {
      problems.push('a move took the lines git wrote that are not commits with it');
    }

    /*
     * Two messages together, which is a held-down Alt and an arrow. Each has to be worked out from the
     * file as it stands after the one before it landed: both reading the text from before either did
     * would leave the second overwriting the first, and since `at` is a place among the commits as the
     * page last drew them, what comes of that is the wrong commit moved rather than an error.
     */
    const beforeBoth = sent.length;

    handler({ type: 'move', at: 0, by: 1 });
    handler({ type: 'action', at: 0, action: 'drop' });
    await until(() => sent.length > beforeBoth + 1);

    const bothLines = text.split('\n');

    console.log('two at once    :', JSON.stringify(bothLines.slice(0, 2)));

    if (!bothLines[0]?.startsWith('drop ') || !bothLines[1]?.startsWith('fixup ')) {
      problems.push(`two changes at once left ${JSON.stringify(bothLines.slice(0, 2))}`);
    }

    // A write the workspace refuses: said out loud, and the list put back to what the file really says.
    refuseEdits = true;
    const beforeRefused = sent.length;

    handler({ type: 'action', at: 0, action: 'reword' });
    await until(() => sent.length > beforeRefused);
    refuseEdits = false;

    const refused = sent.slice(beforeRefused);

    console.log('refused write  :', JSON.stringify(refused.map((message) => message.type)));

    if (!refused.some((message) => message.type === 'failed') || text.split('\n')[0]?.startsWith('reword ')) {
      problems.push(`a refused write left ${JSON.stringify(refused.map((m) => m.type))} and ${JSON.stringify(text.split('\n')[0])}`);
    }

    // Start, which is the whole point of the editor, and a save that fails while it is pressed.
    refuseSave = true;
    const beforeSave = sent.length;

    handler({ type: 'start' });
    await until(() => sent.length > beforeSave);
    refuseSave = false;

    console.log('save refused   :', closed === 0 ? 'still open' : 'CLOSED ANYWAY');

    if (closed !== 0 || !sent.slice(beforeSave).some((message) => message.type === 'failed')) {
      problems.push(`a save that failed closed the editor ${closed} time(s) and said ${JSON.stringify(sent.at(-1))}`);
    }

    handler({ type: 'start' });
    await until(() => closed > 0);

    console.log('start          :', saves, 'save(s),', closed, 'close(s)');

    if (closed === 0) {
      problems.push('Start Rebase did not close the editor, which is what lets git run');
    }

    // Abort is an empty file, saved and closed: that is how git is told to stop.
    const closedBefore = closed;

    handler({ type: 'abort' });
    await until(() => closed > closedBefore);

    console.log('after abort    :', JSON.stringify(text), '| saved', saves, '| closed', closed);

    if (text !== '' || saves === 0 || closed === 0) {
      problems.push(`aborting left ${JSON.stringify(text)}, saved ${saves} time(s), closed ${closed} time(s)`);
    }
  }

  editableDocuments.delete(todoPath);
}

/*
 * Every path that runs git has to stand back for a write in flight.
 *
 * Not a preference. git replaces a file by renaming a lock over it, and Windows refuses that
 * while any other process has the old one open - so a read that overlaps a checkout is what turns
 * the checkout into "unable to write symref for HEAD", with the branch left behind and the whole
 * diff staged. It has been forgotten twice: once on the working-tree refresh, and once on the
 * blame annotations, which are the easiest to miss because they watch editors rather than the
 * graph.
 *
 * Read from the source rather than exercised, because the failure is a race and a run that
 * happens not to lose it proves nothing.
 */
{
  const guards = [
    [
      'src/panel.ts',
      /refreshWorking\(\): Promise<void> \{[\s\S]{0,1400}?isBusy\(this\.repo\.root\)/,
      'reads the working tree without standing back for a write in flight',
    ],
    // And a read that was queued behind another: a write may have begun while the first one ran.
    [
      'src/panel.ts',
      /readWorkingNow\(\): Promise<void> \{[\s\S]{0,400}?isBusy\(this\.repo\.root\)/,
      'reads the working tree again, for a queued request, without standing back for a write',
    ],
    // And git's own settings, written when a slow git status is answered with Enable.
    [
      'src/extension.ts',
      /WeftPanel\.exclusive\(root, async \(\) => \{[\s\S]{0,400}?core\.untrackedCache/,
      "writes git's settings outside the repository's lock",
    ],
    [
      'src/blameAnnotations.ts',
      /this\.isBusy\(repo\.root\)/,
      'blames a file without standing back for a write in flight',
    ],
    // And the one writer that was not a reader: auto-fetch prunes, so it belongs in the queue and
    // not merely behind a look at it.
    [
      'src/panel.ts',
      /autoFetch\(\): Promise<void> \{[\s\S]{0,1200}?lock\.run\(/,
      'fetches - which prunes, and is a write - outside the queue',
    ],

    /*
     * Nothing may hold the walk while it asks a question the walk does not need.
     *
     * `readRepoState` feeds the mid-operation banner and nothing else, and awaiting it put a
     * `git status` - 809ms on a 38,000-file worktree - between the reader and their first row. The
     * stash probes were the same mistake in a loop: three independent questions asked one after
     * another, 649ms of process startup, against a walk of the whole history that takes 462ms.
     */
    [
      'src/panel.ts',
      /void readRepoState\(/,
      'holds the walk for a git status the walk does not need',
    ],
    [
      'src/git/history.ts',
      /async function stashesInWalk[\s\S]{0,2200}?Promise\.all\(/,
      'asks the stash probes one after another, ahead of the first row',
    ],
  ];

  /*
   * Everything the layout produces has to be drawn by something.
   *
   * The merge arcs were computed, serialised onto every page, and then dropped: the view simply
   * never mentioned them. Nothing failed - a graph missing half its merge joins still looks like
   * a graph - and the layout’s own doc comment had said all along that handling one of the two
   * kinds loses half the arcs. A field crossing the wire with no reader is the shape of that.
   *
   * Both halves of the view: the drawing moved into `graph.ts`, and reading only `main.ts` would
   * have called every one of these unread the day it did.
   */
  const view = ['../src/webview/main.ts', '../src/webview/graph.ts']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');

  for (const field of ['links', 'dots', 'paths', 'widths']) {
    if (!new RegExp(`delta\\.${field}`).test(view)) {
      problems.push(`the layout sends ${field} and the view never reads them`);
    }
  }

  /*
   * Nothing the theme decides is remembered from one frame to the next.
   *
   * The lane colours were read once, when the panel said hello, and never again - so switching
   * VS Code from a dark theme to a light one repainted the rows, the badges and the author tints
   * and left the lanes and the dots in the old palette. Everything the stylesheet draws follows a
   * theme on its own; the canvas is drawn from JavaScript and only knows what it was told.
   *
   * So the rule is that a value read out of the stylesheet is read in `measureFrame`, with the
   * rest of what a frame needs, and nowhere else. Cheap - eight reads a frame, measured at
   * 0.0013ms each - and it cannot go stale.
   */
  const measure = view.slice(view.indexOf('function measureFrame()'));
  const frameBody = measure.slice(0, measure.indexOf('\n}\n'));
  const cached = [...view.matchAll(/getPropertyValue\(/g)].length;
  const perFrame = [...frameBody.matchAll(/getPropertyValue\(/g)].length;

  console.log('');
  console.log('theme reads    :', perFrame, 'of', cached, 'inside the frame');

  if (cached !== perFrame) {
    problems.push(
      `${cached - perFrame} stylesheet reads happen outside measureFrame, so they go stale when the theme changes`,
    );
  }

  // And something has to notice the theme moved, or the repaint waits for a scroll.
  if (!/MutationObserver/.test(view)) {
    problems.push('nothing watches for a theme change, so the canvas keeps the old colours');
  }

  /*
   * Every row in the author list can be undone from the row itself.
   *
   * The list has four states and the right-click menu is driven entirely by which one a row is in,
   * so a state nobody wrote a menu entry for is a row whose only useful action is missing. That is
   * exactly what happened: a group the *rule* folded - two spellings it decided were one person -
   * offered "Add to Group…" and nothing else, so being wrong about a fold was not something the
   * list could be told.
   *
   * The `when` clauses are matched the way VS Code matches them: a literal `viewItem == 'x'`, or a
   * regular expression tested against the value.
   */
  const contextMenus = manifest.contributes.menus['view/item/context'] ?? [];

  const offers = (value) =>
    contextMenus
      .filter((entry) => {
        const when = entry.when ?? '';

        if (!when.includes('weft.authors')) {
          return false;
        }

        const pattern = /viewItem =~ \/([^/]+)\//.exec(when);

        return pattern === null
          ? when.includes(`viewItem == '${value}'`) || when.includes(`viewItem == ${value}`)
          : new RegExp(pattern[1]).test(value);
      })
      .map((entry) => entry.command);

  const states = [
    ['weftAuthorGroupCustom', 'weft.ungroupAuthor'],
    ['weftAuthorGroupFolded', 'weft.splitAuthor'],
    ['weftAuthorGroupApart', 'weft.regroupAuthor'],
    ['weftAuthorSpelling', 'weft.splitAuthor'],
    ['weftAuthorSpellingCustom', 'weft.ungroupAuthor'],
  ];

  console.log('');
  console.log('author rows    :', states.map(([value]) => `${value.replace('weftAuthor', '')}`).join(', '));

  for (const [value, wanted] of states) {
    const menu = offers(value);

    if (!menu.includes(wanted)) {
      problems.push(
        `a ${value} row offers ${menu.join(', ') || 'nothing'}, so ${wanted} is out of reach from it`,
      );
    }
  }

  const missing = guards.filter(
    ([path, pattern]) =>
      !pattern.test(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')),
  );

  console.log('');
  console.log(
    'git manners    :',
    missing.length === 0
      ? `${guards.length} shapes held`
      : `UNGUARDED: ${missing.map(([path]) => path).join(', ')}`,
  );

  for (const [path, , complaint] of missing) {
    problems.push(`${path} ${complaint}`);
  }
}

/*
 * Presets: the ticks saved under a name, drawn again in one pick, and deleted.
 *
 * The one saved is not the default, and the refs are read again after drawing it - the way a fetch
 * or a commit would - because a preset that left the default in charge looks right until then.
 */
{
  const provider = treeProviders.get('weft.refs');
  const ticked = () =>
    provider
      .getChildren()
      .flatMap((group) => provider.getChildren(group))
      .filter((node) => provider.getTreeItem(node).checkboxState === 1)
      .map((node) => node.refName)
      .sort();
  const stored = () => Object.values(workspaceMemory.get('weft.refPresets') ?? {})[0] ?? {};

  const allFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();
  await settle(allFrom, SETTLING);
  const saved = ticked();

  inputAnswers.push('everything');
  await commands.get('weft.saveRefPreset')();
  const kept = stored()['everything'];

  // Until the header has been sent the preset - which is the thing the line below reads back.
  const presetsSent = () => JSON.stringify(posted.filter((m) => m.type === 'refs').pop()?.presets ?? []);
  await until(() => presetsSent().includes('"everything"'));

  const menuLists = presetsSent();

  const currentFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showCurrentRefOnly')();
  await settle(currentFrom, SETTLING);

  pickAnswers.push('everything');
  await commands.get('weft.manageRefPresets')();
  await provider.reload();
  const drawn = ticked();
  const offered = picks.at(-1)?.labels ?? [];

  // The same preset from the header's menu: its chip posts the name, and the host draws it.
  const chipFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showCurrentRefOnly')();
  await settle(chipFrom, SETTLING);
  await messageHandler({ type: 'applyRefsPreset', name: 'everything' });
  await provider.reload();
  const fromMenu = ticked();

  pickAnswers.push('$(trash) Delete a Preset…', 'everything');
  await commands.get('weft.manageRefPresets')();
  const left = Object.keys(stored());

  console.log('\npresets        : kept', JSON.stringify(kept ?? null), '| offered', JSON.stringify(offered), '| drew', drawn.length, 'of', saved.length, '| after delete', JSON.stringify(left));

  if (kept?.mode !== 'except' || (kept?.refs ?? []).length !== 0) {
    problems.push('saving everything as a preset kept ' + JSON.stringify(kept) + ', not everything-but-nothing');
  }

  if (JSON.stringify(drawn) !== JSON.stringify(saved)) {
    problems.push('drawing the preset, and reading the refs again, ticked ' + JSON.stringify(drawn) + ', not ' + JSON.stringify(saved));
  }

  if (left.length !== 0) {
    problems.push('deleting the preset left ' + JSON.stringify(left));
  }

  console.log('  in the menu  :', menuLists, '| drawn from its chip:', fromMenu.length, 'of', saved.length);

  if (!menuLists.includes('"everything"')) {
    problems.push("the header's menu was not sent the preset just saved: " + menuLists);
  }

  if (JSON.stringify(fromMenu) !== JSON.stringify(saved)) {
    problems.push("drawing the preset from the header's menu ticked " + JSON.stringify(fromMenu) + ', not ' + JSON.stringify(saved));
  }

  const restoreFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showCurrentRefOnly')();
  await settle(restoreFrom, SETTLING);
}

/*
 * The ticks outlast the session.
 *
 * What a repository was drawing is kept in the workspace, and a new session - a fresh copy of the
 * extension over the same workspace - opens it the same way. The head is kept with the ticks, or the
 * first reload would read the reopening as a checkout and put them back to the default.
 *
 * Last, because it replaces the extension under everything else in this run.
 */
{
  const provider = treeProviders.get('weft.refs');
  const ticked = (p) =>
    p
      .getChildren()
      .flatMap((group) => p.getChildren(group))
      .filter((node) => p.getTreeItem(node).checkboxState === 1)
      .map((node) => node.refName)
      .sort();

  // Something other than the default, so opening on the default cannot pass for remembering.
  const bareFrom = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.untickAllRefs')();
  await settle(bareFrom, SETTLING);

  const tag = provider.getChildren(provider.getChildren().find((g) => g.id === 'tags'))[0];
  const taggedFrom = posted.filter((m) => m.type === 'done').length;
  checkboxHandlers.get('weft.refs')({ items: [[tag, 1]] });
  await settle(taggedFrom, SETTLING);

  const before = ticked(provider);
  const kept = Object.values(workspaceMemory.get('weft.refTicks') ?? {})[0];

  /*
   * A new session: the old one's listeners taken down and its registrations gone, as they are in a
   * new extension host - then a fresh copy of the bundle, over the same workspace.
   */
  for (const disposable of context.subscriptions) {
    disposable?.dispose?.();
  }

  extension.deactivate?.();

  for (const registry of [commands, contentProviders, treeProviders, treeViewOptions, checkboxHandlers, treeViews]) {
    registry.clear();
  }

  const activations = outputLines.filter((line) => line.includes('Weft activated')).length;

  delete require_.cache[require_.resolve(resolve('dist/extension.js'))];
  require_(resolve('dist/extension.js')).activate({ ...context, subscriptions: [] });

  if (!(await until(() => outputLines.filter((line) => line.includes('Weft activated')).length > activations))) {
    problems.push('a second copy of the extension over the same workspace never finished activating');
  }

  await commands.get('weft.openGraph')();

  /*
   * Until the new session's Branches & Tags has read the repository and put ticks on it - and then a
   * moment with nothing moving, because a tree that has been ticked once may still be corrected, and
   * what is being compared is where it comes to rest.
   */
  if (!(await until(() => ticked(treeProviders.get('weft.refs')).length > 0))) {
    problems.push('a new session over the same workspace put no ticks back at all');
  }

  await quiet();

  const after = ticked(treeProviders.get('weft.refs'));

  console.log('\nticks kept     :', JSON.stringify(kept?.set ?? null), '| before', JSON.stringify(before), '| after a restart', JSON.stringify(after));

  if (kept?.v !== 1 || kept?.set?.mode !== 'only') {
    problems.push('the ticks were not kept in the workspace as a set: ' + JSON.stringify(kept));
  }

  if (JSON.stringify(after) !== JSON.stringify(before)) {
    problems.push('a new session opened on ' + JSON.stringify(after) + ', not the ' + JSON.stringify(before) + ' it was left with');
  }
}

/*
 * Pointing the sidebar at the repository it is already on.
 *
 * Every graph taking focus does this, and it used to re-read every ref in the repository each time -
 * with the committer date, which makes git peel each ref to the commit behind it.
 */
{
  const provider = treeProviders.get('weft.refs');
  const root = provider.repoRoot;
  const reads = () => outputLines.filter((line) => line.startsWith('debug') && line.includes('for-each-ref')).length;
  const before = reads();

  await provider.setRepository({ root });
  await provider.setRepository({ root });

  console.log('\nre-pointed     :', reads() - before, 'ref read(s) for being pointed where it already was');

  if (reads() !== before) {
    problems.push(`pointing the sidebar at the repository it is on read the refs ${reads() - before} time(s)`);
  }

  // And it still reads when something asks it to, which is what the watcher does when a ref moves.
  const asked = reads();

  await provider.reload();

  if (reads() === asked) {
    problems.push('the sidebar stopped reading refs even when asked');
  }
}

/*
 * A tick in another repository is not this graph's business.
 *
 * Every filter change used to reload every open graph. Besides the cost - a walk of a whole history
 * nobody asked about - the sidebar answers `visibleRefs` for the repository it is showing and null for
 * any other, and null means every ref: so a graph elsewhere quietly widened from the branch it was
 * drawing to all of them.
 */
{
  const provider = treeProviders.get('weft.refs');
  const here = provider.repoRoot;
  const elsewhere = makeTempRepo();
  const walks = () => posted.filter((m) => m.type === 'done').length;

  // Only `root` is read of it, and the point is where the ticks are filed, not what git says about it.
  await provider.setRepository({ root: elsewhere });

  const before = walks();

  // A tick over there: from that repository's default, which is the branch it is on, to everything.
  await commands.get('weft.showAllRefs')();
  await quiet();

  console.log('\nanother repo   :', walks() - before, 'walk(s) here for a tick there');

  if (walks() !== before) {
    problems.push(`a tick in another repository re-walked this graph ${walks() - before} time(s)`);
  }

  // And back where it belongs: a tick here still reloads this graph, which is the half that must not
  // be lost while fixing the other one.
  await provider.setRepository({ root: here });

  /*
   * Narrowed first, so that widening is certainly a change: whatever the sections above left ticked,
   * "only the branch you are on" and then "everything" cannot both be what it already was.
   */
  await commands.get('weft.showCurrentRefOnly')();
  await settle(walks(), SETTLING);

  const mine = walks();

  await commands.get('weft.showAllRefs')();

  if (!(await until(() => walks() > mine, SETTLING))) {
    problems.push('a tick in this repository no longer reloads its graph');
  }
}

/*
 * A ref read that fails, which is a thing git does: a lock held by another process, a repository read
 * in the middle of a checkout, a permissions blip.
 *
 * It must change nothing. Emptying the list on a failure is read as every ref having gone, which is
 * read as a checkout, which puts the ticks back to the default - so a momentary failure used to throw
 * away a hand-picked set and widen the graph to everything.
 */
{
  const provider = treeProviders.get('weft.refs');
  const listed = () => provider.getChildren().flatMap((group) => provider.getChildren(group)).length;
  // Its own spelling of the root: the provider normalises separators and this path may not have.
  const ticked = () => JSON.stringify(provider.visibleRefs(provider.repoRoot ?? ''));

  /*
   * A hand-picked set to lose, and one the default would never produce: everything except one ref.
   *
   * Ticked everywhere is answered with null - nothing is being narrowed, so there is no set to lose -
   * and 'only the branch you are on' is the default itself, so a reset to it would look exactly like
   * nothing having happened.
   */
  const refsHandler = checkboxHandlers.get('weft.refs');
  const everyRef = () => provider.getChildren().flatMap((group) => provider.getChildren(group));
  const allFrom = posted.filter((m) => m.type === 'done').length;

  await commands.get('weft.showAllRefs')();
  await settle(allFrom, SETTLING);

  // The branch HEAD is on, so that what is left is a set the default would never hand back.
  const victim = everyRef().find((ref) => ref.isHead);
  const untickFrom = posted.filter((m) => m.type === 'done').length;

  refsHandler({ items: [[victim, 0]] });
  await settle(untickFrom, SETTLING);

  const refsBefore = listed();
  const ticksBefore = ticked();

  // git itself made to fail, which is what a lock does to this read, and undone immediately after.
  process.env.GIT_DIR = `${repoPath}/not-a-git-dir`;
  await provider.reload();
  delete process.env.GIT_DIR;

  console.log('\nfailed ref read:', listed(), 'ref(s) still listed | ticks', ticked());

  if (refsBefore === 0 || ticksBefore === 'null') {
    problems.push(`nothing was held before the failed read - ${refsBefore} refs, ticks ${ticksBefore} - so this proves nothing`);
  }

  /*
   * And it has to be a set the default would not produce. The default is the branch HEAD is on and
   * nothing else, so holding exactly that would make a reset to the default look like nothing having
   * happened - which is how the first draft of this check passed while the bug was still there.
   */
  const byDefault = JSON.stringify(everyRef().filter((ref) => ref.isHead).map((ref) => ref.refName));

  if (ticksBefore === byDefault) {
    problems.push(`the set held was ${byDefault}, which is the default one - a reset to it would look like nothing`);
  }

  if (listed() !== refsBefore) {
    problems.push(`a failed ref read left ${listed()} refs listed, not the ${refsBefore} it was holding`);
  }

  if (ticked() !== ticksBefore) {
    problems.push(`a failed ref read changed the ticks from ${ticksBefore} to ${ticked()}`);
  }

  // And a read that works is still the one that decides what is listed and what is ticked.
  await provider.reload();

  if (listed() !== refsBefore || ticked() !== ticksBefore) {
    problems.push(`after the read worked again the sidebar held ${listed()} refs and ${ticked()}`);
  }
}

/*
 * Merges that took a test site's branch somewhere else, and the report of them.
 *
 * Last in the file, because it makes branches and merges of its own and nothing after it should have to
 * know about them. Three merges are made: the one being looked for, the pull on the test branch that
 * outnumbers it in a real repository, and the ordinary way round - a feature going to the test site.
 */
{
  const site = 'uat-site';

  runGit(repoPath, 'checkout', '-q', '-b', site);
  writeFileSync(join(repoPath, 'only-on-the-site.txt'), 'a change only the test site has\n');
  runGit(repoPath, 'add', '-A');
  runGit(repoPath, 'commit', '-q', '-m', 'a change only the test site has');

  runGit(repoPath, 'checkout', '-q', 'main');
  runGit(repoPath, 'checkout', '-q', '-b', 'Dev_Thing');
  writeFileSync(join(repoPath, 'the-feature.txt'), 'the feature\n');
  runGit(repoPath, 'add', '-A');
  runGit(repoPath, 'commit', '-q', '-m', 'the feature');

  // The one being looked for, spelled the way git spells it.
  runGit(repoPath, 'merge', '-q', '--no-ff', site, '-m', `Merge branch '${site}' into Dev_Thing`);

  const taken = runGit(repoPath, 'rev-parse', 'HEAD').trim();

  // And the two that must not be reported: a pull on the test branch, and a feature going to it.
  runGit(repoPath, 'checkout', '-q', site);
  runGit(repoPath, 'merge', '-q', '--no-ff', 'main', '-m', `Merge branch '${site}' of http://host/group/repo into ${site}`);
  runGit(repoPath, 'merge', '-q', '--no-ff', 'Dev_Thing', '-m', `Merge branch 'Dev_Thing' into ${site}`);

  // On main, where the merge above has not arrived: what the report says about that is half of it.
  runGit(repoPath, 'checkout', '-q', 'main');
  await quiet();

  settings.set('weft.testBranches', [site]);
  configurationChanged.fire(['weft.testBranches']);

  const picksBefore = picks.length;
  const revealFrom = posted.length;

  pickAnswers.push(`$(git-merge) Dev_Thing ← ${site}`);
  await commands.get('weft.findTestMerges')();

  const offered = picks.at(-1);
  const labels = offered?.labels ?? [];

  console.log('\ntest merges    :', labels.join(' | ') || '(nothing offered)');
  console.log('  title        :', offered?.title ?? '(none)');

  if (picks.length === picksBefore) {
    problems.push('the test-merge report offered nothing at all');
  } else if (labels.length !== 1 || !labels[0].includes('Dev_Thing') || !labels[0].includes(site)) {
    problems.push(`the test-merge report offered ${JSON.stringify(labels)}`);
  }

  // Not in main yet, which is the half that says a merge is still worth arguing about.
  if (!(offered?.title ?? '').includes('0 already in main')) {
    problems.push(`the test-merge report's title said ${JSON.stringify(offered?.title ?? '')}`);
  }

  if (!(await until(() => posted.slice(revealFrom).some((m) => m.type === 'reveal' && m.sha === taken)))) {
    problems.push('picking a merge from the report never showed it in the graph');
  }

  // And once it has arrived, the report says so rather than listing it the same way.
  runGit(repoPath, 'merge', '-q', '--no-ff', 'Dev_Thing', '-m', "Merge branch 'Dev_Thing' into main");
  await quiet();

  await commands.get('weft.findTestMerges')();

  const after = picks.at(-1);

  console.log('  once in main :', after?.title ?? '(none)');

  if (!(after?.title ?? '').includes('1 already in main')) {
    problems.push(`after the merge arrived the report said ${JSON.stringify(after?.title ?? '')}`);
  }

  // A setting nobody has filled in says what to fill in, rather than an empty list.
  const offersBefore = offers.length;

  settings.delete('weft.testBranches');
  configurationChanged.fire(['weft.testBranches']);
  await commands.get('weft.findTestMerges')();

  if (offers.length === offersBefore || !(offers.at(-1)?.message ?? '').includes('weft.testBranches')) {
    problems.push('with nothing set, the report said nothing about what to set');
  }

  /*
   * A merge picked from the report while the graph is drawing one branch, which is the ordinary state
   * of a graph: the commit is on somebody else's branch, so the walk cannot produce it, and the answer
   * used to be a sentence saying a filter was in the way. The ticks are widened once instead.
   */
  {
    /*
     * A second offending merge, on a branch nothing merges anywhere: the one above has arrived in main
     * by now, so a graph drawing main draws it and there would be nothing here to be behind.
     */
    runGit(repoPath, 'checkout', '-q', '-b', 'Dev_Other', 'main');
    writeFileSync(join(repoPath, 'the-other-feature.txt'), 'the other feature\n');
    runGit(repoPath, 'add', '-A');
    runGit(repoPath, 'commit', '-q', '-m', 'the other feature');
    runGit(repoPath, 'merge', '-q', '--no-ff', site, '-m', `Merge branch '${site}' into Dev_Other`);

    const hidden = runGit(repoPath, 'rev-parse', 'HEAD').trim();

    runGit(repoPath, 'checkout', '-q', 'main');
    await quiet();

    const narrowFrom = posted.filter((m) => m.type === 'done').length;

    await commands.get('weft.showCurrentRefOnly')();
    await settle(narrowFrom, SETTLING);

    const askedFrom = posted.length;

    pickAnswers.push(`$(git-merge) Dev_Other ← ${site}`);
    settings.set('weft.testBranches', [site]);
    configurationChanged.fire(['weft.testBranches']);
    await commands.get('weft.findTestMerges')();

    const widened = await until(
      () => posted.slice(askedFrom).some((m) => m.type === 'reloading' && m.reason.includes('every branch')),
      15_000,
    );
    const said = posted
      .slice(askedFrom)
      .filter((m) => m.type === 'error')
      .map((m) => m.message);

    console.log('  behind a tick:', widened ? 'widened to find it' : 'NEVER WIDENED', '| said', JSON.stringify(said));

    if (!widened) {
      problems.push('a commit asked for from behind the ticks was left behind them');
    }

    if (said.length > 0) {
      problems.push(`asking for a commit behind the ticks said ${JSON.stringify(said)} rather than showing it`);
    }

    /*
     * And it is actually drawn at the end of it, which is the whole point of widening - asked of the
     * pages rather than of the reveal message, which the host posts before any of this and which is
     * therefore there whether the widening happened or not.
     */
    if (!(await until(() => posted.slice(askedFrom).some((m) => m.type === 'page' && m.rows.some((row) => row.sha === hidden))))) {
      problems.push('after widening, the commit was still not drawn');
    }
  }

  /*
   * And the setting filled in by picking, which is the point: the names come from the branches there
   * are, so one with a letter missing is not something a person can produce here.
   */
  pickAnswers.push([site]);
  await commands.get('weft.chooseTestBranches')();

  const choices = picks.at(-1)?.labels ?? [];

  console.log('  offered      :', choices.slice(0, 6).join(', '), choices.length > 6 ? `(+${choices.length - 6})` : '');

  if (!choices.includes(site) || !choices.includes('main')) {
    problems.push(`choosing a test branch offered ${JSON.stringify(choices)}`);
  }

  if (choices.some((label) => label.startsWith('origin/') || label === 'HEAD')) {
    problems.push(`choosing a test branch offered a ref rather than a branch: ${JSON.stringify(choices)}`);
  }

  if (JSON.stringify(settings.get('weft.testBranches')) !== JSON.stringify([site])) {
    problems.push(`choosing a test branch wrote ${JSON.stringify(settings.get('weft.testBranches'))}`);
  }

  // A name no branch has is said in the title rather than looking like a repository with nothing wrong.
  settings.set('weft.testBranches', [site, 'uat-typo']);
  configurationChanged.fire(['weft.testBranches']);
  await commands.get('weft.findTestMerges')();

  const titled = picks.at(-1)?.title ?? '';

  console.log('  with a typo  :', titled);

  // The words, not the name: the setting's names are in the title either way, so looking for one proves nothing.
  if (!titled.includes('no branch here is called uat-typo')) {
    problems.push(`a branch name nothing matches was not said: ${JSON.stringify(titled)}`);
  }

  settings.delete('weft.testBranches');
  configurationChanged.fire(['weft.testBranches']);
}

console.log('\ngit log        :', outputLines.filter((l) => l.startsWith('debug')).length, 'commands');

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const p of problems) {
    console.error(`  - ${p}`);
  }

  process.exit(1);
}

console.log('\nOK - the extension loads, activates, and delivers a graph.');
