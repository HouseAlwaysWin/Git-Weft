/**
 * Where a repository is on the web: which remote to go by, what kind of server it is, and the address
 * its pages hang off.
 *
 * This is the half that has to ask git - the remotes, what HEAD tracks, what Git Credential Manager was
 * told a server is - while `webLinks.ts` is the half that only needs a URL. It is here rather than in the
 * action that opens a page because a link to the file in front of you is not a question about a graph:
 * the editor's own commands answer it with no panel open.
 */

import type { RepoInfo } from './discovery.ts';
import type { Git } from './exec.ts';
import { readRemotes } from './remotes.ts';
import type { Provider, RemoteUrl } from './webLinks.ts';
import { parseRemoteUrl, providerOf, providerOfCredential, repoPage } from './webLinks.ts';

/** A repository's place on the web, or why there is not one to be had. */
export type WebPlace =
  | {
      /** The remote the address was built from. */
      readonly remote: string;
      readonly provider: Provider;
      /** The repository's own page: what every other address hangs off. */
      readonly page: string;
      readonly url: RemoteUrl;
    }
  | { readonly reason: string };

/**
 * The remote to go by when nothing better says: what the branch is tracked on, origin, or the only one
 * there is. Two remotes and no upstream is a question rather than a guess.
 */
export function pickRemote(remotes: readonly string[], upstream: string | null): string | null {
  if (upstream !== null && remotes.includes(upstream)) {
    return upstream;
  }

  if (remotes.includes('origin')) {
    return 'origin';
  }

  return remotes.length === 1 ? (remotes[0] ?? null) : null;
}

/** Which remote's name starts `upstream`, longest first: `origin` and `origin/mirror` can both be remotes. */
export function remoteOfUpstream(upstream: string, remotes: readonly string[]): string | null {
  return (
    [...remotes]
      .sort((a, b) => b.length - a.length)
      .find((name) => upstream === name || upstream.startsWith(`${name}/`)) ?? null
  );
}

/**
 * What Git Credential Manager has been told the server is - `credential.<url>.provider` - which is how a
 * self-hosted server with an address that says nothing is known without a setting in Weft. It asks for a
 * provider's name and nothing else: `--get-urlmatch` reads config, never a credential.
 */
async function credentialProvider(git: Git, repo: RepoInfo, remote: RemoteUrl): Promise<string> {
  const url = `${remote.scheme}://${remote.host}/${remote.path}`;
  return git.runRead(repo.root, ['config', '--get-urlmatch', 'credential.provider', url]).catch(() => '');
}

/**
 * Whether a branch this clone has fetched from the remote holds the commit. One walk that stops at what
 * the remote already has, rather than asking each of a thousand branches in turn.
 */
export async function onRemote(git: Git, repo: RepoInfo, sha: string, remote: string): Promise<boolean> {
  const out = await git.runRead(repo.root, ['rev-list', '-n', '1', sha, '--not', `--remotes=${remote}`]).catch(() => sha);

  return out.trim().length === 0;
}

/**
 * Where a repository's pages are, by `named` where the caller knows which remote it means, and by the
 * usual one where it does not.
 */
export async function webPlace(
  git: Git,
  repo: RepoInfo,
  hosts: Readonly<Record<string, Provider>>,
  named: string | null = null,
): Promise<WebPlace> {
  const remotes = await readRemotes(git, repo);
  const names = remotes.map((remote) => remote.name);
  const upstream = (
    await git.runRead(repo.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')
  ).trim();
  const name = named ?? pickRemote(names, remoteOfUpstream(upstream, names));

  if (name === null) {
    return {
      reason:
        names.length === 0
          ? 'This repository has no remote, so there is no site to open it on'
          : "None of the remotes is origin or this branch's upstream, so there is no telling which to open",
    };
  }

  const raw = remotes.find((remote) => remote.name === name)?.fetchUrl ?? '';
  const url = parseRemoteUrl(raw);

  if (url === null) {
    return { reason: `Nothing to open: ${name} is ${raw}, which is not on a server` };
  }

  const provider = providerOf(url, hosts) ?? providerOfCredential(await credentialProvider(git, repo, url), url);

  if (provider === null) {
    return {
      reason: `Nothing says what kind of server ${url.host} is - name it in weft.remoteHosts, as "${url.host}": "gitlab" or whichever it is`,
    };
  }

  return { remote: name, provider, page: repoPage(provider, url), url };
}
