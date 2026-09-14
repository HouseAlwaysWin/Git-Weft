/**
 * Open a commit, a branch or a tag on the site that hosts the repository.
 *
 * Nothing in the repository changes, so it reports that nothing ran: a run is walked again, and a page
 * in a browser is no reason to walk the history. What it needs first - which remote, which kind of
 * server, whether the remote has the commit at all - it finds out by asking git, which is why it
 * refuses once it has looked rather than greying itself out: every menu would otherwise ask git those
 * questions for an entry most menus are not opened for.
 */

import type { Action, ActionContext, ActionResult } from './types.ts';
import { Tier } from './types.ts';
import { remoteOf } from './network.ts';
import type { RepoState } from '../git/repoState.ts';
import { readRemotes } from '../git/remotes.ts';
import type { RemoteUrl } from '../git/webLinks.ts';
import {
  commitPage,
  parseRemoteUrl,
  providerOf,
  providerOfCredential,
  readRemoteHosts,
  refPage,
  repoPage,
} from '../git/webLinks.ts';

/** Where on a remote a target is found: the remote, and a branch's or a tag's name there. */
type Place =
  | { readonly remote: string; readonly ref: { readonly kind: 'branch' | 'tag'; readonly name: string } | null }
  | { readonly reason: string };

/** Said the way `unavailable` says it, and shown the same way by whoever ran it. */
const refuse = (reason: string): ActionResult => ({ message: reason, ran: false, refused: true });

/** The remote to go by when nothing better says: the current branch's upstream's, origin, the only one. */
function usualRemote(state: RepoState): string | null {
  const tracked = state.upstream === null ? null : remoteOf(state.upstream.ref, state.remotes);

  if (tracked !== null) {
    return tracked;
  }

  if (state.remotes.includes('origin')) {
    return 'origin';
  }

  return state.remotes.length === 1 ? (state.remotes[0] ?? null) : null;
}

async function placeOf({ git, repo, state, target }: ActionContext): Promise<Place> {
  if (target.kind === 'ref' && target.refKind === 'remote') {
    const remote = remoteOf(target.label, state.remotes);

    return remote === null
      ? { reason: `No remote this clone has holds ${target.label}` }
      : { remote, ref: { kind: 'branch', name: target.label.slice(remote.length + 1) } };
  }

  if (target.kind === 'ref' && target.refKind === 'local') {
    // Where it is pushed: its upstream, by the upstream's name, which need not be its own.
    const out = await git
      .runRead(repo.root, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', target.refName])
      .catch(() => '');
    const [remote = '', ref = ''] = out.trim().split('\0');

    if (state.remotes.includes(remote) && ref.startsWith('refs/heads/')) {
      return { remote, ref: { kind: 'branch', name: ref.slice('refs/heads/'.length) } };
    }

    // No upstream - most branches, where they are made locally and pushed by hand. The usual remote's
    // branch of the same name is the one it was pushed as, when there is one.
    const usual = usualRemote(state);
    const there =
      usual === null
        ? ''
        : await git
            .runRead(repo.root, ['rev-parse', '-q', '--verify', `refs/remotes/${usual}/${target.label}`])
            .catch(() => '');

    return usual !== null && there.trim().length > 0
      ? { remote: usual, ref: { kind: 'branch', name: target.label } }
      : { reason: `No remote has ${target.label} yet - once it is pushed, it opens` };
  }

  const remote = usualRemote(state);

  if (remote === null) {
    return { reason: "None of the remotes is origin or this branch's upstream, so there is no telling which to open" };
  }

  return target.kind === 'ref' ? { remote, ref: { kind: 'tag', name: target.label } } : { remote, ref: null };
}

/**
 * What Git Credential Manager has been told the server is - `credential.<url>.provider` - which is how
 * a self-hosted server with an address that says nothing is known without a setting in Weft. It asks
 * for a provider's name and nothing else: `--get-urlmatch` reads config, never a credential.
 */
async function credentialProvider({ git, repo }: ActionContext, remote: RemoteUrl): Promise<string> {
  const url = `${remote.scheme}://${remote.host}/${remote.path}`;
  return git.runRead(repo.root, ['config', '--get-urlmatch', 'credential.provider', url]).catch(() => '');
}

/**
 * Whether a branch this clone has fetched from the remote holds the commit. One walk that stops at
 * what the remote already has, rather than asking each of a thousand branches in turn.
 */
async function onRemote({ git, repo }: ActionContext, sha: string, remote: string): Promise<boolean> {
  const out = await git
    .runRead(repo.root, ['rev-list', '-n', '1', sha, '--not', `--remotes=${remote}`])
    .catch(() => sha);

  return out.trim().length === 0;
}

const openOnWeb: Action = {
  id: 'weft.openOnWeb',
  group: 'web',
  tier: Tier.Safe,

  label: (target) =>
    target.kind !== 'ref' ? 'Open Commit on the Web' : target.refKind === 'tag' ? 'Open Tag on the Web' : 'Open Branch on the Web',

  appliesTo: (target) => target.kind === 'commit' || target.kind === 'ref',

  unavailable: (_target, state) => (state.remotes.length === 0 ? 'No remote to open it on' : null),

  async run(context) {
    const { git, repo, target, ui } = context;
    const place = await placeOf(context);

    if ('reason' in place) {
      return refuse(place.reason);
    }

    const name = place.remote;
    const url = (await readRemotes(git, repo)).find((remote) => remote.name === name)?.fetchUrl ?? '';
    const remote = parseRemoteUrl(url);

    if (remote === null) {
      return refuse(`Nothing to open: ${name} is ${url}, which is not on a server`);
    }

    const provider =
      providerOf(remote, readRemoteHosts(ui.remoteHosts())) ??
      providerOfCredential(await credentialProvider(context, remote), remote);

    if (provider === null) {
      return refuse(
        `Nothing says what kind of server ${remote.host} is - name it in weft.remoteHosts, as "${remote.host}": "gitlab" or whichever it is`,
      );
    }

    const page = repoPage(provider, remote);

    if (target.kind === 'commit') {
      // Asked, not refused: this clone may simply not have fetched since it was pushed.
      if (!(await onRemote(context, target.sha, name))) {
        const anyway = await ui.confirm({
          title: `${target.sha.slice(0, 8)} is not on ${name}`,
          detail:
            `No branch this clone has fetched from ${name} holds it. It may not have been pushed, or ` +
            `pushed since the last fetch - and until it is there, ${remote.host} has no page for it.`,
          confirmLabel: 'Open Anyway',
          destructive: false,
        });

        if (!anyway) {
          return { message: '', ran: false };
        }
      }

      await ui.openUrl(commitPage(provider, page, target.sha));
    } else if (place.ref !== null) {
      await ui.openUrl(refPage(provider, page, place.ref.kind, place.ref.name));
    }

    // Nothing in the repository moved: reported as not run, so nothing is walked again for it.
    return { message: '', ran: false };
  },
};

export const WEB_ACTIONS: readonly Action[] = [openOnWeb];
