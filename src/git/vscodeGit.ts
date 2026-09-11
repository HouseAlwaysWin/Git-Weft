/**
 * The built-in git extension, used only for the things it notices before Weft could.
 *
 * Weft runs the git CLI itself and does not want an intermediary, but VS Code's own git extension
 * is already polling: it knows when a repository is opened and when the working tree changes, and
 * both are events Weft has no way to generate for itself. `RepoWatcher` watches `.git`, which is
 * exactly right for refs and exactly wrong for a file being saved.
 *
 * Nothing here is load-bearing. The API is exported but effectively unversioned, so every path
 * through this module ends in "then there is one fewer trigger", never in an error.
 */

import { realpathSync } from 'node:fs';

import * as vscode from 'vscode';

interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<unknown> };
}

interface GitApi {
  readonly repositories: readonly Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

/** The git extension's API, activating it if VS Code has not got round to it yet. */
async function api(): Promise<GitApi | null> {
  try {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git');

    if (extension === undefined) {
      return null;
    }

    return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
  } catch {
    // Disabled, or the shape moved. Either way there is nothing to subscribe to.
    return null;
  }
}

/**
 * One directory, spelled the way the filesystem spells it.
 *
 * This is the one place in Weft where two producers of a path meet: a root here came from
 * `git rev-parse --show-toplevel`, and the git extension's came from its own resolution. One
 * directory has more than one name - `C:\Users\MARTIN~1\...` and `C:\Users\Martin_Wang\...` are
 * the same folder, and 8.3 short names are handed out by plenty of things that make paths - so
 * comparing the two as text says they are different.
 *
 * Measured: `mkdtemp` returns the short form and `--show-toplevel` the long one for the very same
 * directory. Junctions and symlinks part the same way, which is why both sides are resolved rather
 * than one being normalised towards the other.
 *
 * A silent failure, and the module's own promise is what hid it: every path through here ends in
 * one fewer trigger rather than an error, so the subscription simply never happened and the
 * working-tree row sat there stale with nothing to say it should not have.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path).replace(/\\/g, '/').toLowerCase();
  } catch {
    // Gone, or a filesystem without a real path to give. The spelling as handed over is what is
    // left, and it is what this compared before.
    return path.replace(/\\/g, '/').toLowerCase();
  }
}

/** Collects subscriptions that may not exist yet, and disposes whatever arrived by the time it is. */
function pending(work: (add: (subscription: vscode.Disposable) => void) => Promise<void>): {
  dispose(): void;
} {
  const subscriptions: vscode.Disposable[] = [];
  let disposed = false;

  void work((subscription) => {
    if (disposed) {
      subscription.dispose();
    } else {
      subscriptions.push(subscription);
    }
  });

  return {
    dispose() {
      disposed = true;

      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    },
  };
}

/**
 * Call `onChange` when a repository is opened or closed.
 *
 * Weft's own discovery is a filesystem walk with nothing to subscribe to, so a repository that
 * appears after startup - a `git init`, or a clone into a folder that is already open - would
 * otherwise stay invisible until the window is reloaded, and the Source Control sections with it.
 */
export function watchRepositories(onChange: () => void): { dispose(): void } {
  return pending(async (add) => {
    const git = await api();

    if (git === null) {
      return;
    }

    add(git.onDidOpenRepository(onChange));
    add(git.onDidCloseRepository(onChange));
  });
}

/**
 * Call `onChange` when the working tree of `root` changes.
 *
 * This is the one thing `RepoWatcher` cannot see. It watches `.git`, because that is where a ref
 * moving shows up and watching a whole worktree would mean an event per keystroke of an editor's
 * autosave - but it means saving a file moves nothing it is looking at, and the row that stands for
 * the working tree would sit there stale until something else happened to cause a reload.
 *
 * The git extension is already running `git status` on its own, so listening costs nothing. What
 * it does not do is space its events out for us: nothing stops several arriving close together, and
 * a listener that reads once per event reads several times per change. The panel waits for them to
 * go quiet, and reads one at a time.
 */
export function watchWorkingTree(root: string, onChange: () => void): { dispose(): void } {
  return pending(async (add) => {
    const git = await api();

    if (git === null) {
      return;
    }

    const wanted = canonical(root);

    /*
     * Guarded, because this runs outside the `try` above: an event handler is called later, by
     * someone else, with whatever shape that version of the API hands over. The module claims that
     * every path through it costs at most one trigger rather than an error, and until this was
     * written the claim held for the subscription and not for the callback.
     */
    const watch = (repository: Repository): void => {
      try {
        if (canonical(repository.rootUri.fsPath) === wanted) {
          add(repository.state.onDidChange(onChange));
        }
      } catch {
        // One fewer trigger.
      }
    };

    for (const repository of git.repositories) {
      watch(repository);
    }

    // The repository may not be open yet - Weft finds repositories the git extension has not been
    // asked about, and a bare one it will never open at all.
    add(git.onDidOpenRepository(watch));
  });
}
