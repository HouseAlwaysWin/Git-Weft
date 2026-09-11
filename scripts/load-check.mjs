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
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
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
const confirmations = [];
const progressTitles = [];
const statusMessages = [];

/** Whether the stub says yes to a confirmation. A run needs both answers to prove a refusal. */
let confirmed = true;

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
    createOutputChannel: () => ({
      info: (m) => outputLines.push(`info  ${m}`),
      warn: (m) => outputLines.push(`warn  ${m}`),
      error: (m) => outputLines.push(`error ${m}`),
      debug: (m) => outputLines.push(`debug ${m}`),
      show() {},
      dispose() {},
    }),
    showInformationMessage: (m) => problems.push(`unexpected info message: ${m}`),
    /*
     * A warning with buttons is a confirmation, and this answers it with the first one - which is
     * how a user gets past `ui.confirm`. Until this existed every confirmation returned undefined,
     * every tier-2 action read that as "cancelled", and nothing that asks before it acts had ever
     * run to completion here.
     *
     * A warning with no buttons is still nobody's plan, and still a failure.
     */
    showWarningMessage: async (m, options, ...choices) => {
      if (choices.length === 0) {
        problems.push(`unexpected warning: ${m}`);
        return undefined;
      }

      confirmations.push({ message: m, detail: options?.detail ?? '', answered: choices[0] });
      return confirmed ? choices[0] : undefined;
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
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
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
                    state: { onDidChange: repositoryState.event },
                  },
                ],
                onDidOpenRepository: repositoryOpened.event,
                onDidCloseRepository: repositoryClosed.event,
              }),
            },
          }
        : undefined,
  },
  env: { clipboard: { writeText: async (text) => void copied.push(text) } },
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

await new Promise((r) => setTimeout(r, 800));

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

  await commands.get('weft.showAllRefs')();
  await new Promise((r) => setTimeout(r, 1500));

  const baseline = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;

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

    const settle = async (from) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length <= from) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
    };

    const send = async (preset) => {
      const from = posted.filter((m) => m.type === 'done').length;
      await messageHandler({ type: 'refsPreset', preset });
      return settle(from);
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

    // From the default, which is the branch HEAD is on and nothing else.
    await commands.get('weft.showCurrentRefOnly')();
    await new Promise((r) => setTimeout(r, 1200));

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
  await new Promise((r) => setTimeout(r, 2000));

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
  await new Promise((r) => setTimeout(r, 2000));

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

  await messageHandler({ type: 'runAction', id: 'weft.checkoutBranch', target: side });
  await new Promise((r) => setTimeout(r, 2500));

  console.log('  menu path    : HEAD is', head(), '| asked', confirmations.length - beforeMenu, 'times');

  if (confirmations.length - beforeMenu !== 1) {
    problems.push(`checking out from a menu asked ${confirmations.length - beforeMenu} times, not once`);
  }

  if (head() !== 'side') {
    problems.push('saying yes to the menu dialog did not check the branch out');
  }

  const backToMain = async () => {
    confirmed = true;
    await messageHandler({
      type: 'runAction',
      id: 'weft.checkoutBranch',
      target: { kind: 'ref', refName: 'refs/heads/main', label: 'main', refKind: 'local' },
    });
    await new Promise((r) => setTimeout(r, 2500));
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
    await new Promise((r) => setTimeout(r, 2500));
    const askedNo = confirmations.length - beforeNo;
    const afterNo = head();

    confirmed = true;
    const beforeYes = confirmations.length;
    await commands.get('weft.checkoutRef')(sideNode);
    await new Promise((r) => setTimeout(r, 2500));
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
  await new Promise((r) => setTimeout(r, 2500));
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

    await commands.get('weft.showAllRefs')();
    await new Promise((r) => setTimeout(r, 1200));

    const chosen = tickedNow().length;

    await messageHandler({
      type: 'runAction',
      id: 'weft.checkoutBranch',
      target: { kind: 'ref', refName: 'refs/heads/side', label: 'side', refKind: 'local' },
    });

    await new Promise((r) => setTimeout(r, 2500));

    const after = tickedNow();

    console.log('');
    console.log('checkout ticks :', chosen, 'ticked ->', after.map((r) => r.label).join(', ') || '(nothing)');

    if (after.length !== 1 || after[0]?.refName !== 'refs/heads/side') {
      problems.push(
        `a checkout should leave only the new branch ticked; ticked: ${after.map((r) => r.label).join(', ') || 'nothing'}`,
      );
    }

    // Back to main, so nothing after this is reading a different branch's history.
    await messageHandler({
      type: 'runAction',
      id: 'weft.checkoutBranch',
      target: { kind: 'ref', refName: 'refs/heads/main', label: 'main', refKind: 'local' },
    });

    await new Promise((r) => setTimeout(r, 2500));
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

      refsHandler({ items: [[victim, 0]] });
      await new Promise((r) => setTimeout(r, 1200));
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
  await commands.get('weft.showAllRefs')();
  await new Promise((r) => setTimeout(r, 1500));

  await typeIntoRefFilter('side');

  const reloadsBefore = posted.filter((m) => m.type === 'done').length;
  await commands.get('weft.showAllRefs')();

  const restored = treeProvider.getChildren().flatMap((g) => treeProvider.getChildren(g)).length;
  console.log(`  show all     : back to ${restored} refs`);

  if (restored !== before) {
    problems.push(`Show All left the text filter applied (${restored} of ${before} refs listed)`);
  }

  // And it should not have re-walked the history: no tick changed, so the graph is unaffected.
  await new Promise((r) => setTimeout(r, 400));

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

    await commands.get('weft.showAllRefs')();
    await new Promise((r) => setTimeout(r, 500));
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

  await commands.get('weft.showAllRefs')();
  await new Promise((r) => setTimeout(r, 500));

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
       * Let the walk before this one land first. The block above ends by putting every ref back,
       * and reading the baseline while that reload is still in flight gets the narrowed number -
       * against which the author filter appears to have narrowed nothing.
       */
      await new Promise((r) => setTimeout(r, 1500));

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
  await commands.get('weft.showAllAuthors')();
  await new Promise((r) => setTimeout(r, 1200));

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

  const settle = async (from) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length <= from) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  };

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
  await new Promise((r) => setTimeout(r, 2500));

  if (posted.filter((m) => m.type === 'done').length > quietFrom) {
    problems.push('writing an untracked file triggered a needless reload');
  } else {
    console.log('quiet churn    : ignored, as it should be');
  }
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
  await commands.get('weft.showAllRefs')();
  await new Promise((r) => setTimeout(r, 1500));

  const baseline = posted.filter((m) => m.type === 'done').pop()?.total ?? 0;

  // The graph is no longer the focused editor, exactly as it is not when a sidebar is being used.
  if (panelObject !== null && viewStateHandler !== null) {
    panelObject.active = false;
    viewStateHandler();
  }

  const settle = async (from) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length <= from) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  };

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
    await new Promise((r) => setTimeout(r, 1500));

    const walks = posted.filter((m) => m.type === 'done').length - walksBeforeGroup;
    console.log('group of', many.length, 'hidden:', walks, 'walk' + (walks === 1 ? '' : 's'));

    // One message, one walk. Sending these one at a time would redraw the history per branch,
    // which is the reason the message carries a list rather than a name.
    if (walks !== 1) {
      problems.push(`hiding ${many.length} branches at once cost ${walks} walks of the history`);
    }

    await commands.get('weft.showAllRefs')();
    await new Promise((r) => setTimeout(r, 500));
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

    if (hits.length === 0) {
      problems.push(`${entry.command} is in the manifest but its when clause matches no ref`);
    }
  }

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

  const settle = async (from) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'done').length <= from) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return posted.filter((m) => m.type === 'done').pop()?.total ?? -1;
  };

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
    messageHandler({ type: 'compare', from: oldest.sha, to: newest.sha });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && posted.filter((m) => m.type === 'comparison').length === before) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const comparison = posted.filter((m) => m.type === 'comparison').pop();

    console.log(
      '\ncompare        :',
      comparison === undefined
        ? 'NO ANSWER'
        : `${comparison.from.slice(0, 8)} → ${comparison.to.slice(0, 8)} | ${comparison.files} files | ${comparison.onlyFrom} left, ${comparison.onlyTo} right`,
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
  await new Promise((r) => setTimeout(r, 200));

  const timer = intervals[intervals.length - 1];
  console.log('auto-fetch     :', intervals.length > scheduled ? `every ${timer.ms} ms` : 'NOT SCHEDULED');

  if (intervals.length === scheduled) {
    problems.push('turning auto-fetch on scheduled nothing');
  } else if (timer.ms !== 5 * 60_000) {
    problems.push(`auto-fetch asked for 5 minutes and scheduled ${timer.ms} ms`);
  }

  settings.set('weft.autoFetchMinutes', 0);
  configurationChanged.fire(['weft.autoFetchMinutes']);
  await new Promise((r) => setTimeout(r, 200));

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
  await new Promise((r) => setTimeout(r, 400));
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

  if (victim === undefined) {
    problems.push('no branch to delete from the tree');
  } else {
    await commands.get('weft.deleteRef')(victim);

    const by = Date.now() + 15_000;
    while (Date.now() < by && confirmations.length === before) {
      await new Promise((r) => setTimeout(r, 25));
    }

    await new Promise((r) => setTimeout(r, 1500));

    const asked = confirmations.at(-1);
    const inGit = runGit(repoPath, 'branch', '--list', 'side').trim();
    const listed = heads().some((node) => node.label === 'side');

    console.log('\ndelete branch  :', JSON.stringify(asked?.message ?? '(never asked)'));
    console.log('  git has it   :', inGit.length > 0 ? inGit : 'no');
    console.log('  tree lists it:', listed);

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
 * Closing the graph, which nothing here had ever done. Everything the panel holds is released in
 * one place - the watcher, the auto-fetch timer - and with no graph left to select in, the file
 * list is showing a commit nobody can point at.
 */
if (disposeHandler !== null) {
  disposeHandler();
  await new Promise((r) => setTimeout(r, 200));

  const filesView = treeViews.get('weft.files');
  const filesProvider = treeProviders.get('weft.files');

  console.log('panel closed   :', JSON.stringify(filesView?.message ?? ''), '|', filesProvider?.getChildren().length, 'files listed');

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

  await messageHandler({ type: 'order', order: 'topo' });
  await new Promise((r) => setTimeout(r, 2500));

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
  await messageHandler({ type: 'order', order: 'date' });
  await new Promise((r) => setTimeout(r, 2000));

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
  await new Promise((r) => setTimeout(r, 2000));

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
 */
{
  const columns = () =>
    decorations.flat().filter((entry) => entry?.renderOptions?.before !== undefined);

  const before = columns().length;

  await commands.get('weft.toggleFileBlame')();
  await new Promise((r) => setTimeout(r, 2000));

  const drawn = columns();
  const text = drawn[drawn.length - 1]?.renderOptions?.before?.contentText ?? '';

  console.log('');
  console.log('file blame     :', drawn.length > before ? JSON.stringify(text) : 'NOTHING DRAWN');

  if (drawn.length === before) {
    problems.push('Toggle File Blame drew no column');
  } else if (!/\d{4}-\d{2}-\d{2}/.test(text)) {
    problems.push(`the file blame column drew "${text}", which does not say when`);
  }

  await commands.get('weft.toggleFileBlame')();
  await new Promise((r) => setTimeout(r, 500));

  const last = decorations[decorations.length - 1];
  const cleared = Array.isArray(last) && last.length === 0;

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

console.log('\ngit log        :', outputLines.filter((l) => l.startsWith('debug')).length, 'commands');

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const p of problems) {
    console.error(`  - ${p}`);
  }

  process.exit(1);
}

console.log('\nOK - the extension loads, activates, and delivers a graph.');
