import * as vscode from 'vscode';
import { basename, dirname } from 'node:path';

import { Git } from './git/exec.ts';
import type { RepoInfo } from './git/discovery.ts';
import { discover } from './git/discovery.ts';
import { WeftPanel, setCommitFiles, setPanelLogger } from './panel.ts';
import { RevisionContentProvider, SCHEME } from './contentProvider.ts';
import type { RefsPreset } from './protocol.ts';
import { RefsProvider } from './refsView.ts';
import type { AuthorNode } from './authorsView.ts';
import { AuthorsProvider } from './authorsView.ts';
import { FilesProvider, openFileDiff } from './filesView.ts';
import { BlameAnnotations } from './blameAnnotations.ts';
import { LineHistoryProvider } from './lineHistoryView.ts';
import { lineHistory } from './git/lineHistory.ts';
import { watchRepositories } from './git/vscodeGit.ts';
import { SlowReads, fsmonitorCanRun, statusOffer } from './git/statusAdvice.ts';

let output: vscode.LogOutputChannel | undefined;

/**
 * Every repository folder VS Code knows about, most specific first.
 *
 * The built-in git extension is asked first because it has already done the work and knows about
 * repositories the user opened manually. It is never load-bearing though: the API is exported but
 * effectively unversioned, so a missing or changed shape falls back to the workspace folders.
 */
function candidateFolders(): string[] {
  const folders: string[] = [];

  try {
    const gitExtension = vscode.extensions.getExtension<{
      getAPI(version: number): { repositories: { rootUri: vscode.Uri }[] };
    }>('vscode.git');

    const api = gitExtension?.isActive === true ? gitExtension.exports.getAPI(1) : undefined;

    for (const repo of api?.repositories ?? []) {
      folders.push(repo.rootUri.fsPath);
    }
  } catch {
    // The built-in git extension is disabled or its API moved. Workspace folders still work.
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') {
      folders.push(folder.uri.fsPath);
    }
  }

  /*
   * The folder holding the open file, not the file.
   *
   * `discover` runs git with this as its working directory, and a file is not a directory to run
   * anything in - Node reports that as `spawn git ENOENT`, indistinguishable at a glance from git
   * not being installed. It took the whole presence update down with it: the rejection was silent,
   * so the context key the Source Control sections are gated on was never set and all three
   * vanished - while the graph, opened later with no editor focused, worked perfectly.
   */
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    folders.unshift(dirname(active.fsPath));
  }

  return [...new Set(folders)];
}

/**
 * The first candidate folder that turns out to be a repository, or null if none are.
 *
 * A candidate that cannot even be looked at is a candidate that is not a repository. Letting one
 * of them throw would abandon the folders behind it *and* whatever the caller was going to do with
 * the answer, which is a great deal of damage for a path that was only ever a guess.
 */
async function findRepositories(git: Git): Promise<RepoInfo[]> {
  const folders = candidateFolders();

  /*
   * All of them at once, rather than one after another.
   *
   * The candidates are usually the same repository arrived at three ways - the built-in git
   * extension knows it, it is the workspace folder, and the open file is inside it - and each one
   * costs four `rev-parse` calls whether or not it lands somewhere already found. Measured on a
   * 78,000-commit repository: 176ms each, so three candidates were half a second of waiting before
   * anything appeared, for one answer.
   *
   * Nothing is spawned in a storm doing this: `Git` caps how many processes it runs at once and
   * queues the rest.
   */
  const settled = await Promise.all(
    folders.map((folder) =>
      discover(git, folder).catch((err: unknown) => {
        output?.debug(
          `not a usable folder: ${folder} (${err instanceof Error ? err.message : String(err)})`,
        );

        return null;
      }),
    ),
  );

  const found = new Map<string, RepoInfo>();

  // Keyed by root: several candidate folders can sit inside one repository, and the first one that
  // resolved is the one whose position in the list means something. In candidate order, not in the
  // order they happened to finish, or the head of the list would be whichever git answered first.
  for (const repo of settled) {
    if (repo !== null && !found.has(repo.root)) {
      found.set(repo.root, repo);
    }
  }

  return [...found.values()];
}

/**
 * Something on screen while a command works before it has anything to show.
 *
 * The graph opens from a button in Source Control, and between the click and the tab there is
 * discovery and a ref list - a moment on a small repository, and long enough on a large or a cold
 * one to look like the button did nothing. The tab's own progress bar cannot help: it is inside the
 * webview, and the webview is what is being waited for.
 *
 * `Window` rather than a notification, which is the status bar's spinner: this is the wait before a
 * thing appears, not an operation somebody should be told about.
 */
function whileOpening<T>(title: string, work: () => Promise<T>): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, work),
  );
}

async function findRepository(git: Git): Promise<RepoInfo | null> {
  for (const folder of candidateFolders()) {
    try {
      const repo = await discover(git, folder);

      if (repo !== null) {
        return repo;
      }
    } catch (err) {
      output?.debug(`not a usable folder: ${folder} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return null;
}

/**
 * Ask which repository, showing enough to tell two checkouts of the same project apart.
 *
 * The path, not just the folder name: `web` and `web` are two different answers, and the only thing
 * that distinguishes them is where they are.
 */
async function pickRepository(found: readonly RepoInfo[]): Promise<RepoInfo | null> {
  const chosen = await vscode.window.showQuickPick(
    found.map((repo) => ({
      label: basename(repo.root),
      description: repo.root,
      repo,
    })),
    { title: 'Which repository?', placeHolder: 'Weft opens one graph per repository' },
  );

  return chosen?.repo ?? null;
}

/** Put something on the clipboard and say so, briefly - a copy with no feedback reads as a no-op. */
async function copy(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(`Weft: copied ${text}`, 2000);
}

/** Run an action that targets the repository, which needs a graph to run against. */
function repoAction(id: string): void {
  const panel = WeftPanel.active();

  if (panel === null) {
    void vscode.window.showInformationMessage('Weft: open the graph first.');
    return;
  }

  panel.runRepoAction(id);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Weft', { log: true });
  setPanelLogger(output);
  context.subscriptions.push(output);

  try {
    start(context);
  } catch (err) {
    /*
     * Activation is all or nothing, and its failure is silent by default.
     *
     * Everything Weft contributes hangs off the end of `start`: the commands are registered there,
     * and the three Source Control sections are gated on a context key it sets. An exception
     * anywhere in it therefore does not lose one feature, it loses all of them - and VS Code says
     * nothing beyond a line in a log nobody has open.
     *
     * The way this is reached in development is a window whose manifest is older than its code:
     * `createTreeView` throws for a view the running window has never heard of, which is what
     * happens after a new view is added and the Extension Development Host is not restarted.
     */
    const message = err instanceof Error ? err.message : String(err);

    output.error(`Weft failed to activate: ${message}`);

    void vscode.window
      .showErrorMessage(`Weft failed to activate: ${message}`, 'Show Log')
      .then((choice) => {
        if (choice === 'Show Log') {
          output?.show();
        }
      });
  }
}

/** Where each repository's answer to the offer below is kept: its root, to 'never' or 'enabled'. */
const STATUS_ANSWERS = 'weft.statusAnswers';

/**
 * Offer git's own switches for a slow `git status` in `root` - once a session at most, and never
 * again for a repository that answered for good.
 *
 * The settings are written through the repository's lock, like every other write: a `git config`
 * landing in the middle of a checkout is a write alongside a write.
 */
async function offerFasterStatus(git: Git, root: string, memento: vscode.Memento): Promise<void> {
  if (memento.get<Record<string, string>>(STATUS_ANSWERS, {})[root] !== undefined) {
    return;
  }

  const setting = async (key: string): Promise<string | null> => {
    const result = await git.tryRead(root, ['config', '--get', key]).catch(() => null);
    return result?.exitCode === 0 ? result.stdout.trim() : null;
  };

  const [untrackedCache, fsmonitor, recent] = await Promise.all([
    setting('core.untrackedCache'),
    setting('core.fsmonitor'),
    git.atLeast(2, 37),
  ]);

  const probe = recent ? await git.tryRead(root, ['fsmonitor--daemon', 'status']).catch(() => null) : null;
  const offer = statusOffer({ untrackedCache, fsmonitor }, fsmonitorCanRun(probe?.exitCode ?? null));

  if (!offer.untrackedCache && !offer.fsmonitor) {
    return;
  }

  const name = basename(root);
  const both = offer.untrackedCache && offer.fsmonitor;
  const what = both
    ? "git's untracked cache and filesystem monitor"
    : offer.fsmonitor
      ? "git's filesystem monitor"
      : "git's untracked cache";
  const enable = both ? 'Enable Them' : 'Enable It';

  const choice = await vscode.window.showInformationMessage(
    both
      ? `git status is slow in ${name}. Turn on ${what} for this repository? Both are git's own settings, off by default.`
      : `git status is slow in ${name}. Turn on ${what} for this repository? It is git's own setting, off by default.`,
    enable,
    'Not Now',
    'Never for This Repository',
  );

  // Read again rather than reusing the first read: another repository may have answered meanwhile.
  const keep = (answer: string): Thenable<void> =>
    memento.update(STATUS_ANSWERS, { ...memento.get<Record<string, string>>(STATUS_ANSWERS, {}), [root]: answer });

  if (choice === 'Never for This Repository') {
    await keep('never');
    return;
  }

  // Not Now, or closed: this session has had its one offer, and a later one may ask again.
  if (choice !== enable) {
    return;
  }

  try {
    await WeftPanel.exclusive(root, async () => {
      if (offer.untrackedCache) {
        await git.runWrite(root, ['config', '--local', 'core.untrackedCache', 'true']);
      }

      if (offer.fsmonitor) {
        await git.runWrite(root, ['config', '--local', 'core.fsmonitor', 'true']);
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output?.warn(`could not change git's settings in ${root}: ${message}`);
    void vscode.window.showWarningMessage(`Weft: could not change git's settings in ${name}: ${message}`);
    return;
  }

  await keep('enabled');
  void vscode.window.setStatusBarMessage(`Weft: turned on ${what} in ${name}`, 5000);
}

/** Name the ticks as they are, to draw them again later in one pick. */
async function saveRefPreset(refs: RefsProvider): Promise<void> {
  if (refs.repoRoot === null) {
    void vscode.window.showInformationMessage('Weft: open the graph first.');
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Save the current ticks as a preset',
    prompt: 'A name to draw them by later. Saving under a name already used replaces it.',
    validateInput: (value) => (value.trim().length === 0 ? 'A preset needs a name' : null),
  });

  if (name === undefined) {
    return;
  }

  refs.savePreset(name);
  void vscode.window.setStatusBarMessage(`Weft: saved the ticks as ${name.trim()}`, 3000);
}

/**
 * The named presets: draw one, save the ticks as they are as another, or delete one. A pick rather
 * than a view of their own, because a preset is something you choose, not something you watch.
 */
async function manageRefPresets(refs: RefsProvider): Promise<void> {
  if (refs.repoRoot === null) {
    void vscode.window.showInformationMessage('Weft: open the graph first.');
    return;
  }

  const presets = refs.presets();
  const listed = presets.map((preset) => ({ label: preset.name, description: preset.describes }));
  const save = '$(add) Save the Current Ticks…';
  const remove = '$(trash) Delete a Preset…';

  const picked = await vscode.window.showQuickPick(
    [
      ...listed,
      { label: save, description: '' },
      ...(presets.length === 0 ? [] : [{ label: remove, description: '' }]),
    ],
    {
      title: 'Branch presets',
      placeHolder: presets.length === 0 ? 'None saved yet' : 'Draw one, or save the ticks as they are',
    },
  );

  if (picked === undefined) {
    return;
  }

  if (picked.label === save) {
    await saveRefPreset(refs);
    return;
  }

  if (picked.label === remove) {
    const doomed = await vscode.window.showQuickPick(listed, { title: 'Delete which preset?' });

    if (doomed !== undefined) {
      refs.deletePreset(doomed.label);
    }

    return;
  }

  refs.applyPreset(picked.label);
}

/**
 * Compare two branches or tags from outside the graph: the one right-clicked in Branches & Tags - or,
 * from the palette, one picked here as well - and another chosen from the rest. It lands in the
 * repository's graph as a comparison picked there would: the distance in the details pane, the files
 * in Commit Files.
 */
async function compareRefs(refs: RefsProvider, node: unknown): Promise<void> {
  const root = refs.repoRoot;

  if (root === null) {
    void vscode.window.showInformationMessage('Weft: open the graph first.');
    return;
  }

  const every = refs.listRefs();
  const pick = async (title: string, except: string | null): Promise<{ rev: string; label: string } | null> => {
    const chosen = await vscode.window.showQuickPick(
      every
        .filter((ref) => ref.refName !== except)
        .map((ref) => ({ label: ref.label, description: ref.group, rev: ref.refName })),
      { title, placeHolder: 'A branch or a tag' },
    );

    return chosen === undefined ? null : { rev: chosen.rev, label: chosen.label };
  };

  const picked = refs.targetOf(node);
  const from =
    picked === null
      ? await pick('Compare which branch or tag?', null)
      : { rev: picked.refName, label: picked.label };

  if (from === null) {
    return;
  }

  const to = await pick(`Compare ${from.label} with…`, from.rev);

  if (to !== null && !(await WeftPanel.compareIn(root, from, to))) {
    void vscode.window.showInformationMessage('Weft: open the graph first.');
  }
}

function start(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('weft');

  // Slow reads of the working tree, per repository: the third gets one offer to make them faster.
  const slowReads = new SlowReads();

  const git = new Git({
    maxConcurrent: config.get<number>('maxConcurrentGitProcesses', 4),
    networkIdleTimeoutMs: config.get<number>('networkIdleTimeoutSeconds', 60) * 1000,
    onCommand: (entry) => {
      const line = `git ${entry.args.join(' ')} (${entry.durationMs}ms)`;
      if (entry.failed) {
        output?.warn(`${line} -> exit ${entry.exitCode}`);
      } else {
        output?.debug(line);
      }

      if (entry.args[0] === 'status' && !entry.failed) {
        const slowMs = vscode.workspace.getConfiguration('weft').get<number>('statusSlowMs', 500);

        if (slowReads.record(entry.cwd, entry.durationMs, slowMs)) {
          void offerFasterStatus(git, entry.cwd, context.workspaceState);
        }
      }
    },
  });

  const refs = new RefsProvider(git, context.workspaceState);
  const refsView = vscode.window.createTreeView('weft.refs', {
    treeDataProvider: refs,
    showCollapseAll: true,

    /*
     * Weft owns the checkboxes, because VS Code and Weft disagree about what a group's tick
     * means. Weft says "some of these are shown"; VS Code reads a ticked parent as "every child is
     * ticked" and drives them all back on - so unticking one branch put the tick straight back,
     * because the group it lives in still had others showing.
     */
    manageCheckboxStateManually: true,
  });

  /*
   * The workspace's own memory, for the groups made by hand. They are a judgement about one
   * repository’s contributors, so they belong to the workspace rather than to the machine.
   */
  const authors = new AuthorsProvider(git, context.workspaceState);
  const authorsView = vscode.window.createTreeView('weft.authors', { treeDataProvider: authors });

  /*
   * The selected commit's files. `globalState` rather than the workspace's, because tree-or-flat is
   * how someone likes to read a file list, not something about this repository.
   */
  const files = new FilesProvider(context.globalState);
  const filesView = vscode.window.createTreeView('weft.files', { treeDataProvider: files });

  /*
   * The lines somebody asked about. Its own section rather than the graph narrowed down, because
   * `git log -L` walks from one commit and cannot be the graph's walk with a filter on it.
   */
  const lines = new LineHistoryProvider();
  const linesView = vscode.window.createTreeView('weft.lineHistory', { treeDataProvider: lines });

  lines.attach(linesView);

  files.attach(filesView);
  setCommitFiles({
    show: (repo, details) => files.setCommit(repo, details),
    working: (repo, changes) => files.setWorking(repo, changes),
    compared: (repo, comparison, labels) => files.setComparison(repo, comparison, labels),
    clear: () => files.setCommit(null, null),
  });

  /*
   * Blame on the editor: the line the cursor is on, always, and the whole file on request. It
   * listens to the window rather than to the graph, so a workspace with no graph open still gets
   * it - which is the point of it.
   */
  const blame = new BlameAnnotations(git, (root) => WeftPanel.isBusy(root));

  // Read fresh on every reload, so neither view has to push anything at the panel.
  const filters = {
    refs: (root: string) => refs.visibleRefs(root),
    refsNarrowed: (root: string) => refs.isNarrowed(root),
    authorPicks: (root: string) => authors.authorPicks(root),
    /*
     * Follow the graph that is being looked at.
     *
     * The sidebar shows one repository, and every open graph reloads when a tick moves - so the one
     * it shows has to be the one in front, or the ticks belong to a graph nobody is looking at.
     */
    activated: (repo: RepoInfo) => {
      void refs.setRepository(repo);
      authors.setRepository(repo);
    },
    listRefs: () => refs.listForMenu(),
    refPresets: () => refs.presets(),
    applyRefPreset: (name: string) => void refs.applyPreset(name),
    refsMoved: () => refs.reload(),
    setRefsVisible: (refNames: readonly string[], visible: boolean) =>
      refs.setVisible(refNames, visible),
    setRefsPreset: (preset: RefsPreset) => {
      if (preset === 'all') {
        refs.showAll();
      } else if (preset === 'none') {
        refs.untickAll();
      } else {
        refs.followHead();
      }
    },
    // `reset` rather than `showAll`: neither view asks for a reload, because the panel is about to.
    clear: () => {
      refs.reset();
      authors.reset();
    },
  };

  context.subscriptions.push(
    refsView,
    authorsView,
    filesView,

    /*
     * Who last changed the line the cursor is on, at the end of that line. Nothing else here knows
     * about editors, so it is its own thing: it listens to the window rather than to the graph, and
     * a workspace with no graph open still gets it.
     */
    blame,

    refs.attach(refsView),
    authors.attach(authorsView),

    // Either filter narrows the walk, so the graph is rebuilt rather than merely repainted.
    /*
     * Every open graph, not the focused one. Ticking a box in Source Control is itself the act of
     * unfocusing the graph, so `active()` here was reliably null and the filter reliably did
     * nothing - the one place where "the graph the user is looking at" is the wrong graph.
     */
    refs.onDidChangeFilter(() => WeftPanel.refreshAll()),
    // Only the list moved, so only the list is sent again.
    refs.onDidChangeOrder(() => WeftPanel.refreshRefs()),
    refs.onDidChangePresets(() => WeftPanel.refreshRefs()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('weft.branchFolders')) {
        refs.refold();
        WeftPanel.refreshRefs();
      }
    }),
    authors.onDidChangeFilter(() => WeftPanel.refreshAll()),

    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(git)),

    vscode.commands.registerCommand('weft.openGraph', async () => {
      if (candidateFolders().length === 0) {
        void vscode.window.showInformationMessage('Weft: open a folder containing a git repository first.');
        return;
      }

      const found = await whileOpening('Weft: looking for a repository…', () =>
        findRepositories(git),
      );

      /*
       * Which repository, when there is more than one.
       *
       * `candidateFolders` puts the folder of the open file first, so the head of this list is
       * already the one most likely meant - it is offered first and nothing is remembered. A
       * workspace with several repositories is one where the answer changes with what you are
       * looking at, so a remembered choice would be wrong more often than it was right.
       */
      const repo =
        found.length <= 1
          ? (found[0] ?? null)
          : await pickRepository(found);

      if (repo === null) {
        if (found.length === 0) {
          void vscode.window.showWarningMessage('Weft: no git repository found in this workspace.');
        }

        return;
      }

      // The ref list is read here rather than by the panel, so it has to be waited for here too.
      await whileOpening(`Weft: opening ${basename(repo.root)}…`, async () => {
        await refs.setRepository(repo);
        authors.setRepository(repo);
      });

      WeftPanel.show(
        context.extensionUri,
        git,
        repo,
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
        filters,
      );
    }),

    /*
     * A commit named somewhere other than the graph - the line-end blame - and the graph brought
     * to it.
     *
     * Beside rather than over: the reader is in a file and asked what one of its lines is about,
     * so taking the file off screen to answer would be trading one question for another. Opens a
     * graph if there is none, because "open the graph first" is a step they did not ask about.
     */
    vscode.commands.registerCommand('weft.revealCommit', async (args: unknown) => {
      const ask = args as { sha?: unknown; root?: unknown } | undefined;
      const sha = typeof ask?.sha === 'string' ? ask.sha : null;
      const root = typeof ask?.root === 'string' ? ask.root : null;

      if (sha === null || root === null) {
        return;
      }

      const repo = await discover(git, root);

      if (repo === null) {
        void vscode.window.showInformationMessage(
          'Weft: that file is not in a git repository any more.',
        );
        return;
      }

      await refs.setRepository(repo);
      authors.setRepository(repo);

      WeftPanel.show(
        context.extensionUri,
        git,
        repo,
        vscode.ViewColumn.Beside,
        filters,
      ).revealCommit(sha);
    }),

    /*
     * The history of the lines in front of you.
     *
     * The question blame raises and does not answer: blame says who touched a line last, this says
     * who touched it before that. From the selection, or from the line the cursor is on when there
     * is no selection - which is the same gesture the inline blame already answers about.
     */
    vscode.commands.registerCommand('weft.showLineHistory', async () => {
      const editor = vscode.window.activeTextEditor;

      if (editor === undefined || editor.document.uri.scheme !== 'file') {
        return;
      }

      const path = editor.document.uri.fsPath;
      const repo = await discover(git, dirname(path)).catch(() => null);

      if (repo === null) {
        void vscode.window.showInformationMessage('Weft: that file is not in a git repository.');
        return;
      }

      // Editors count from zero and `-L` counts from one, which is a difference worth making in
      // one place rather than at both ends of it.
      const range = {
        path: await repoRelative(git, path),
        from: editor.selection.start.line + 1,
        to: editor.selection.end.line + 1,
      };

      try {
        lines.show(repo.root, range, await lineHistory(git, repo, range));
        await vscode.commands.executeCommand('weft.lineHistory.focus');
      } catch (err) {
        /*
         * Said out loud rather than left as an empty list. A range past the end of the file, or a
         * file git has never heard of, is a `fatal:` with a reason in it - and since the walk
         * stopped discarding what git says, the reason is worth showing.
         */
        void vscode.window.showWarningMessage(
          `Weft: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('weft.clearLineHistory', () => lines.clear()),

    vscode.commands.registerCommand('weft.toggleFileBlame', () => blame.toggleFile()),

    vscode.commands.registerCommand('weft.showAllRefs', () => refs.showAll()),

    vscode.commands.registerCommand('weft.showOnlyListedRefs', () => refs.showOnlyListed()),

    /*
     * Copying, in the two trees. The graph's own menu answers its copies itself - it has the text
     * already and nothing about them is the host's business - but a tree view's menu is contributed
     * through the manifest, so these need commands to point at.
     */
    vscode.commands.registerCommand('weft.copyRefName', async (node: unknown) => {
      const target = refs.targetOf(node);

      if (target !== null) {
        await copy(target.label);
      }
    }),

    vscode.commands.registerCommand('weft.copyFullRefName', async (node: unknown) => {
      const target = refs.targetOf(node);

      if (target !== null) {
        await copy(target.refName);
      }
    }),

    vscode.commands.registerCommand('weft.copyFilePath', async (node: unknown) => {
      const target = files.target(node);

      if (target !== null) {
        await copy(target.file.path);
      }
    }),

    vscode.commands.registerCommand('weft.copyAbsoluteFilePath', async (node: unknown) => {
      const target = files.target(node);

      if (target !== null) {
        // The path on this machine, separators and all, because that is what it is for: pasting
        // into something that is not git.
        await copy(vscode.Uri.joinPath(vscode.Uri.file(target.repo), target.file.path).fsPath);
      }
    }),

    /*
     * The sidebar's own actions. They take the node the tree hands them rather than a name typed
     * somewhere, so the full ref name travels with the target and `main` the branch can never be
     * confused with `main` the tag.
     */
    vscode.commands.registerCommand('weft.showOnlyRef', (node: unknown) => {
      const target = refs.targetOf(node);

      if (target !== null) {
        refs.showOnly(target.refName);
      }
    }),

    vscode.commands.registerCommand('weft.checkoutRef', (node: unknown) => {
      const target = refs.targetOf(node);

      if (target === null) {
        return;
      }

      const panel = WeftPanel.any();

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: open the graph first.');
        return;
      }

      panel.runTargetAction(
        target.refKind === 'remote' ? 'weft.checkoutRemoteBranch' : 'weft.checkoutBranch',
        { kind: 'ref', ...target },
      );
    }),

    /*
     * Delete, from the tree rather than from a badge in the graph.
     *
     * Which action that means depends on what was right-clicked, and the two are not
     * interchangeable: deleting a branch can strand commits and says so, deleting a tag cannot.
     * The manifest keeps this off remote branches entirely - removing one of those is a push to a
     * server, not a change to this clone, and it does not belong on the same menu as the two that
     * only touch what is here.
     */
    vscode.commands.registerCommand('weft.deleteRef', (node: unknown) => {
      const target = refs.targetOf(node);

      if (target === null || target.refKind === 'remote') {
        return;
      }

      const panel = WeftPanel.any();

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: open the graph first.');
        return;
      }

      panel.runTargetAction(target.refKind === 'tag' ? 'weft.deleteTag' : 'weft.deleteBranch', {
        kind: 'ref',
        ...target,
      });
    }),

    /*
     * And the remote one, which is a separate command rather than a branch inside the one above.
     * The menus take their wording from the command, so two of them is what lets the entry say
     * "on Remote" - the whole difference being that this one is a push to a server and the other
     * two only touch this clone. One entry called Delete for both would be the wrong word half
     * the time, in the direction that costs the most.
     */
    vscode.commands.registerCommand('weft.deleteRemoteRef', (node: unknown) => {
      const target = refs.targetOf(node);

      if (target === null || target.refKind !== 'remote') {
        return;
      }

      const panel = WeftPanel.any();

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: open the graph first.');
        return;
      }

      panel.runTargetAction('weft.deleteRemoteBranch', { kind: 'ref', ...target });
    }),

    vscode.commands.registerCommand('weft.showAllAuthors', () => authors.showAll()),

    /*
     * One gesture for every filter there is, wherever it was set - the two sidebar views and the
     * graph's own search and date range. With no graph open there is nothing to reload, so the two
     * views clear themselves the ordinary way.
     */
    vscode.commands.registerCommand('weft.clearFilters', () => {
      const panel = WeftPanel.active();

      if (panel === null) {
        refs.showAll();
        authors.showAll();
        return;
      }

      return panel.clearFilters();
    }),

    vscode.commands.registerCommand('weft.filesAsTree', () => files.setAsTree(true)),
    vscode.commands.registerCommand('weft.filesAsList', () => files.setAsTree(false)),

    /*
     * Clicking a file opens its diff. The node arrives from the tree item rather than an index into
     * a list, so there is no way for the two to drift out of step with each other.
     */
    /*
     * One file's history. The path comes from the node the tree hands over rather than from
     * anything typed, which matters more than usual: `--follow` will not take a case-insensitive
     * pathspec, so the spelling has to be git's own.
     */
    vscode.commands.registerCommand('weft.showFileHistory', async (node: unknown) => {
      const fromTree = files.target(node);

      if (fromTree !== null) {
        const panel = WeftPanel.any();

        if (panel === null) {
          void vscode.window.showInformationMessage('Weft: open the graph first.');
          return;
        }

        panel.showFileHistory(fromTree.file.path);
        return;
      }

      /*
       * Or a file picked anywhere else - the Explorer, an editor, a tab - which arrives as a Uri
       * and knows nothing about which repository it is in or what git calls it.
       *
       * The tree could assume both, because its files came out of a commit Weft had already
       * walked. Everything here has to be worked out: which repository the path is under, what it
       * is called relative to that root, and which graph is showing it - opening one beside the
       * file if there is none, because being told to open a graph first is a step nobody asked
       * about.
       */
      const uri = asUri(node) ?? vscode.window.activeTextEditor?.document.uri;

      if (uri === undefined || uri.scheme !== 'file') {
        return;
      }

      const repo = await discover(git, dirname(uri.fsPath));

      if (repo === null) {
        void vscode.window.showInformationMessage(
          'Weft: that file is not in a git repository.',
        );
        return;
      }

      await refs.setRepository(repo);
      authors.setRepository(repo);

      WeftPanel.show(
        context.extensionUri,
        git,
        repo,
        vscode.ViewColumn.Beside,
        filters,
      ).showFileHistory(await repoRelative(git, uri.fsPath));
    }),

    vscode.commands.registerCommand('weft.openCommitFile', async (node: unknown) => {
      const target = files.target(node);

      if (target !== null) {
        await openFileDiff(target.repo, target.subject, target.file);
      }
    }),

    /*
     * A tree view cannot host a text field, so the query is typed into one of VS Code's own inputs.
     * A quick pick rather than an input box, for two reasons: it offers the ref names as you type
     * instead of asking you to remember them, and it can react to every keystroke - so the list in
     * the sidebar narrows live behind it rather than only once you press Enter.
     */
    vscode.commands.registerCommand('weft.filterRefs', () => {
      const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { ref?: string }>();
      const before = refs.filterText;

      picker.title = 'Filter branches and tags';
      picker.placeholder = 'Type to narrow the list, or pick one';
      picker.value = before;
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.items = refs.listRefs().map((ref) => ({
        label: ref.label,
        description: ref.group,
        detail: ref.refName,
        ref: ref.label,
      }));

      let accepted = false;

      picker.onDidChangeValue((value) => refs.setQuery(value));

      picker.onDidAccept(() => {
        accepted = true;
        // Picking an entry filters to exactly it; accepting with nothing highlighted keeps whatever
        // was typed, which is how you filter to a group of refs rather than one.
        refs.setQuery(picker.selectedItems[0]?.ref ?? picker.value);
        picker.hide();
      });

      picker.onDidHide(() => {
        // Escape undoes the live filtering. Leaving it applied would make cancelling do something.
        if (!accepted) {
          refs.setQuery(before);
        }

        picker.dispose();
      });

      picker.show();
    }),

    /*
     * The same picker as the ref filter, over the other list that gets long.
     *
     * Authors differ in one way that matters here: the tick means "show only these", so filtering
     * the list and then ticking what is left is the whole gesture - narrow to a team, show the
     * graph that team. `weft.showOnlyListedAuthors` is the second half of it.
     */
    vscode.commands.registerCommand('weft.untickAllRefs', () => refs.untickAll()),
    vscode.commands.registerCommand('weft.saveRefPreset', () => saveRefPreset(refs)),
    vscode.commands.registerCommand('weft.manageRefPresets', () => manageRefPresets(refs)),
    vscode.commands.registerCommand('weft.compareRef', (node: unknown) => compareRefs(refs, node)),
    vscode.commands.registerCommand('weft.compareBranches', () => compareRefs(refs, undefined)),
    vscode.commands.registerCommand('weft.listTickedRefs', () => refs.setTickedOnly(true)),
    vscode.commands.registerCommand('weft.sortRefsByRecent', () => refs.setOrder('recent')),
    vscode.commands.registerCommand('weft.sortRefsByName', () => refs.setOrder('name')),
    vscode.commands.registerCommand('weft.listAllRefs', () => refs.setTickedOnly(false)),
    vscode.commands.registerCommand('weft.showCurrentRefOnly', () => refs.followHead()),

    /*
     * Put a spelling, or a whole person, with somebody else - and in as many places as they belong.
     *
     * The spelling rule folds what it can prove - case and separators - and stops there, because a
     * list that quietly merges two people is worse than one that shows a person twice. Everything
     * past that is a judgement only the reader can make: `Lineric` and `lineric_lin` share a prefix
     * and nothing else, and whether they are one person is not in the repository.
     *
     * Adding rather than moving, because the same person is on the platform team and on the release
     * rota. The groups they are already in are left off the list: joining one twice is not an
     * option worth offering.
     */
    vscode.commands.registerCommand('weft.groupAuthor', async (node: unknown) => {
      const target = asAuthorNode(node);

      if (target === undefined) {
        return;
      }

      const label = authors.labelOf(target);
      const already = new Set(authors.groupsOf(target).map((name) => name.toLowerCase()));
      const existing = authors
        .groupNames()
        .filter((name) => name !== label && !already.has(name.toLowerCase()));

      const picked = await vscode.window.showQuickPick(
        [
          { label: 'New group…', description: `under a name of its own`, group: null as string | null },
          ...existing.map((name) => ({ label: name, description: '', group: name as string | null })),
        ],
        { title: `Add ${label} to…`, placeHolder: 'An existing person or group, or a new one' },
      );

      if (picked === undefined) {
        return;
      }

      const named =
        picked.group ??
        (await vscode.window.showInputBox({
          title: `Name the group for ${label}`,
          value: label,
          validateInput: (value) => (value.trim().length === 0 ? 'A group needs a name' : null),
        }));

      if (named === undefined || named.trim().length === 0) {
        return;
      }

      authors.addToGroup(authors.spellingsOf(target), named.trim());
    }),

    /*
     * And out of the one that was right-clicked, which is not the same as out of all of them: a
     * spelling shown under three groups has three rows, and taking it out of the one in front of
     * you is what clicking that row means.
     *
     * Out of the last one is not the same as alone either. With no assignments left the spelling
     * goes back to the rule, which may well put it straight where it was - that is the right
     * answer, because a group is an override and removing one restores what was underneath.
     */
    vscode.commands.registerCommand('weft.ungroupAuthor', (node: unknown) => {
      const target = asAuthorNode(node);

      if (target !== undefined) {
        authors.removeFromGroup(authors.spellingsOf(target), authors.groupAt(target));
      }
    }),

    /*
     * The rule was wrong about these two.
     *
     * It folds by case and separators - `Max_Chiue` and `max_chiue` - because nine times in ten
     * that is one person who has configured git twice. The tenth time it is two people, and until
     * now the list had no way to be told: the group it made offered nothing but "add to a group",
     * and adding both to one would have said the opposite of what was meant.
     *
     * On a whole group it takes all of them apart; on one spelling inside it, just that one, which
     * is the case where three of four really are the same person.
     */
    vscode.commands.registerCommand('weft.splitAuthor', (node: unknown) => {
      const target = asAuthorNode(node);

      if (target !== undefined) {
        authors.setApart(authors.spellingsOf(target));
      }
    }),

    /*
     * And back to the rule, which is where undoing a correction should land - not on a third state
     * that has to be undone in turn. The rule is a guess, and it is usually right.
     */
    vscode.commands.registerCommand('weft.regroupAuthor', (node: unknown) => {
      const target = asAuthorNode(node);

      if (target !== undefined) {
        authors.letTheRuleDecide(authors.spellingsOf(target));
      }
    }),

    vscode.commands.registerCommand('weft.sortAuthorsByName', () => authors.setOrder('name')),
    vscode.commands.registerCommand('weft.sortAuthorsByCommits', () => authors.setOrder('commits')),

    vscode.commands.registerCommand('weft.filterAuthors', async () => {
      // The list is loaded lazily, when the section is first expanded. Opening the picker is asking
      // for it, so ask for it rather than offering an empty one.
      await authors.getChildren();

      const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { author?: string }>();
      const before = authors.filterText;

      picker.title = 'Filter authors';
      picker.placeholder = 'Type to narrow the list, or pick one';
      picker.value = before;
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.items = authors.listAuthors().map((author) => ({
        label: author.name,
        description: `${author.commits}`,
        detail: author.emails.join(', '),
        author: author.name,
      }));

      let accepted = false;

      picker.onDidChangeValue((value) => authors.setQuery(value));

      picker.onDidAccept(() => {
        accepted = true;
        // Picking an entry narrows to exactly it; accepting what was typed keeps that, which is how
        // you narrow to everyone at one company rather than to one person.
        authors.setQuery(picker.selectedItems[0]?.author ?? picker.value);
        picker.hide();
      });

      picker.onDidHide(() => {
        // Escape undoes the live filtering. Leaving it applied would make cancelling do something.
        if (!accepted) {
          authors.setQuery(before);
        }

        picker.dispose();
      });

      picker.show();
    }),

    vscode.commands.registerCommand('weft.showOnlyListedAuthors', () => authors.showOnlyListed()),

    vscode.commands.registerCommand('weft.stash', () => repoAction('weft.stashPush')),

    /*
     * Fetch, pull and push, whose command ids are their action ids. Force push is deliberately not
     * among the title-bar buttons: it is the one action here that can destroy work living only on
     * someone else's clone, and a button for it one pixel from Push is an accident waiting to
     * happen. The command palette is far enough away to be a decision.
     */
    ...['weft.fetch', 'weft.pull', 'weft.push', 'weft.pushForce', 'weft.manageRemotes'].map((id) =>
      vscode.commands.registerCommand(id, () => repoAction(id)),
    ),

    vscode.commands.registerCommand('weft.refresh', () => {
      const panel = WeftPanel.active();

      if (panel === null) {
        void vscode.window.showInformationMessage('Weft: no graph is open.');
        return;
      }

      panel.refresh();
    }),

    vscode.commands.registerCommand('weft.showGitLog', () => output?.show()),
  );

  /*
   * One click to the graph itself. Weft's two views sit in Source Control, and a view container
   * opens views rather than running commands, so the status bar is what gets you straight to the
   * thing you came for.
   *
   * It is hidden in workspaces with no repository, because an entry point to something that cannot
   * open is worse than no entry point.
   */
  const statusBar = vscode.window.createStatusBarItem(
    'weft.open',
    vscode.StatusBarAlignment.Left,
    100,
  );

  statusBar.name = 'Weft';
  /*
   * A codicon, because that is all a status bar item can hold: `text` takes the `$(name)` syntax
   * and nothing else, so the extension's own mark - which the tab and the Source Control button
   * both wear - cannot come here.
   *
   * `circuit-board` rather than `git-branch`: lines with nodes sitting on them is the closest the
   * set gets to what this opens, and it is not one of the icons git already uses for its own
   * things a few pixels away.
   */
  statusBar.text = '$(circuit-board) Weft';
  statusBar.tooltip = 'Open the Weft commit graph';
  statusBar.command = 'weft.openGraph';
  context.subscriptions.push(statusBar);

  /*
   * Does this workspace have a repository at all?
   *
   * Two things hang off the answer: the status bar entry, and whether Weft's two views appear in
   * Source Control. A workspace with nothing to graph should not carry two collapsed sections under
   * someone else's changes list - Weft is a guest in that container now, not the owner of its own.
   */
  const updatePresence = async (): Promise<void> => {
    const repo = await findRepository(git);

    await vscode.commands.executeCommand('setContext', 'weft.hasRepository', repo !== null);

    const enabled = vscode.workspace
      .getConfiguration('weft')
      .get<boolean>('statusBar.enabled', true);

    if (repo === null || !enabled) {
      statusBar.hide();
    } else {
      statusBar.show();
    }

    /*
     * Populate the views here rather than waiting for the graph, so a section that has only just
     * appeared - after a `git init`, say - is not an empty room when it is first expanded.
     *
     * A graph that is already open owns them: the panel draws itself through their filters, so
     * re-pointing them at another repository underneath it would filter a history by refs it has
     * never heard of.
     */
    if (WeftPanel.active() === null) {
      authors.setRepository(repo);
      await refs.setRepository(repo);
    }
  };

  /*
   * The git extension announces repositories one at a time, so a window opened on four of them
   * would otherwise pay for four discovery passes in a row to arrive at the same answer.
   */
  let pending: NodeJS.Timeout | null = null;

  const schedulePresenceUpdate = (): void => {
    if (pending !== null) {
      clearTimeout(pending);
    }

    pending = setTimeout(() => {
      pending = null;
      void updatePresence();
    }, 200);
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(schedulePresenceUpdate),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('weft.statusBar.enabled')) {
        schedulePresenceUpdate();
      }
    }),
    watchRepositories(schedulePresenceUpdate),
    {
      dispose() {
        if (pending !== null) {
          clearTimeout(pending);
          pending = null;
        }
      },
    },
  );

  void updatePresence();

  output?.info('Weft activated');
}

export function deactivate(): void {
  output = undefined;
}

/**
 * What git calls a file, asked rather than worked out.
 *
 * Subtracting the repository root from an absolute path looks like the obvious answer and is
 * not: the two strings come from different places and do not have to match. Windows hands VS
 * Code an 8.3 short name while `rev-parse` returns the long one, a drive letter arrives in
 * whichever case it feels like, and either end may have gone through a symlink. A prefix that
 * does not match leaves the absolute path behind - which git accepts, and walks nothing for.
 * An empty graph and no error.
 *
 * `--show-prefix` is git answering about its own repository, from inside the directory in
 * question, so there is nothing to compare.
 */
async function repoRelative(git: Git, path: string): Promise<string> {
  const prefix = await git.runRead(dirname(path), ['rev-parse', '--show-prefix']).catch(() => '');

  return `${prefix.trim()}${basename(path)}`;
}

/**
 * A Uri, told by its shape rather than by `instanceof`.
 *
 * Which class a Uri is an instance of depends on who built it, and menu arguments do not always
 * come from this extension host - so the test that reads as the obvious one is the one that returns
 * false for a perfectly good Uri.
 */
function asUri(value: unknown): vscode.Uri | undefined {
  const candidate = value as vscode.Uri | undefined;

  return typeof candidate?.fsPath === 'string' && typeof candidate.scheme === 'string'
    ? candidate
    : undefined;
}

/** A node from the Authors tree, told by its shape - menu arguments arrive as `unknown`. */
function asAuthorNode(value: unknown): AuthorNode | undefined {
  const candidate = value as AuthorNode | undefined;

  return candidate?.kind === 'group' || candidate?.kind === 'member' ? candidate : undefined;
}
