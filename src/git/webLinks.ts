/**
 * Where a commit, a branch or a tag lives on the site that hosts its repository.
 *
 * Pure: a remote's URL in, a web address out. Which kind of server a remote is has to be known before
 * any address can be built, and a URL alone often cannot say - `http://10.20.30.40/erp/dlp.git` is a
 * GitLab, and nothing in it says so. What a URL can say is read here; what has to be asked of git's
 * config is asked by the action that opens the page, and handed in.
 */

/** The kinds of server whose addresses Weft knows how to build. */
export const PROVIDERS = ['github', 'gitlab', 'gitea', 'bitbucket', 'bitbucket-server', 'azure-devops'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** A remote's URL, taken apart as far as a web address needs it. */
export interface RemoteUrl {
  /** How the site is reached: the remote's own scheme when it is http or https, https for ssh. */
  readonly scheme: 'http' | 'https';
  /** The host, with the port an http or https remote named - an ssh port is not the site's. */
  readonly host: string;
  /** The repository's path on the server: no slash at either end, no `.git`. */
  readonly path: string;
}

/** Transports that reach a server, and so name a host with a site. */
const SERVER = new Set(['http', 'https', 'ssh', 'git', 'git+ssh', 'ssh+git']);

/** Hosts that only take ssh, and the site each belongs to. */
const SSH_HOSTS: Readonly<Record<string, string>> = {
  'ssh.github.com': 'github.com',
  'altssh.gitlab.com': 'gitlab.com',
  'altssh.bitbucket.org': 'bitbucket.org',
};

/**
 * A remote's URL taken apart, or null when it is not on a server - a path on disk, a `file://` URL,
 * anything git would need a helper of its own to read.
 */
export function parseRemoteUrl(url: string): RemoteUrl | null {
  const text = url.trim();
  const full = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)(?::(\d*))?(\/.*)?$/.exec(text);

  if (full !== null) {
    const scheme = (full[1] ?? '').toLowerCase();

    if (!SERVER.has(scheme)) {
      return null;
    }

    // A port is the site's only when the remote is the site: an ssh port says nothing about the web.
    const port = scheme === 'http' || scheme === 'https' ? (full[3] ?? '') : '';
    const usual = port === '' || port === (scheme === 'http' ? '80' : '443');

    return build(scheme === 'http' ? 'http' : 'https', full[2] ?? '', usual ? null : port, full[4] ?? '');
  }

  // `[user@]host:path` - scp's shape, which git reads as ssh. A host of one letter is a Windows drive.
  const scp = /^(?:[^@/\\]+@)?([^/\\:]{2,}):(?!\/\/)(.+)$/.exec(text);
  return scp === null ? null : build('https', scp[1] ?? '', null, scp[2] ?? '');
}

function build(scheme: 'http' | 'https', rawHost: string, port: string | null, rawPath: string): RemoteUrl | null {
  const lower = rawHost.toLowerCase();
  let host = SSH_HOSTS[lower] ?? lower;
  let path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');

  // Azure DevOps clones over ssh from a host of its own, by a path its site does not use.
  const azure = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);

  if (azure !== null && host === 'ssh.dev.azure.com') {
    host = 'dev.azure.com';
    path = `${azure[1]}/${azure[2]}/_git/${azure[3]}`;
  } else if (azure !== null && host === 'vs-ssh.visualstudio.com') {
    host = `${azure[1]}.visualstudio.com`;
    path = `${azure[2]}/_git/${azure[3]}`;
  }

  if (host.length === 0 || path.length === 0) {
    return null;
  }

  return { scheme, host: port === null ? host : `${host}:${port}`, path };
}

/** Hosts everybody knows. */
const KNOWN: Readonly<Record<string, Provider>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'dev.azure.com': 'azure-devops',
  'codeberg.org': 'gitea',
  'gitea.com': 'gitea',
};

/** Words a self-hosted server's name tends to carry. A Bitbucket that is not bitbucket.org is a Server. */
const WORDS: readonly (readonly [string, Provider])[] = [
  ['gitlab', 'gitlab'],
  ['github', 'github'],
  ['gitea', 'gitea'],
  ['forgejo', 'gitea'],
  ['bitbucket', 'bitbucket-server'],
];

/**
 * What serves a remote, from what can be known without asking: `weft.remoteHosts` first, then the
 * hosts everybody knows, then a host whose name says what it is, then a path only one kind of server
 * makes. null when none of them says - which is when Git Credential Manager's config is asked.
 */
export function providerOf(remote: RemoteUrl, hosts: Readonly<Record<string, Provider>>): Provider | null {
  const bare = remote.host.replace(/:\d+$/, '');
  const named = hosts[remote.host] ?? hosts[bare];

  if (named !== undefined) {
    return named;
  }

  const known = KNOWN[bare] ?? (bare.endsWith('.visualstudio.com') ? 'azure-devops' : undefined);

  if (known !== undefined) {
    return known;
  }

  const word = WORDS.find(([text]) => bare.includes(text));

  if (word !== undefined) {
    return word[1];
  }

  if (/(?:^|\/)scm\/[^/]+\/[^/]+$/.test(remote.path)) {
    return 'bitbucket-server';
  }

  return /\/_git\/[^/]+$/.test(remote.path) ? 'azure-devops' : null;
}

/**
 * What Git Credential Manager has been told a server is - `credential.<url>.provider` - as one of the
 * kinds here. `generic` and `auto` say nothing, and nor does an empty answer.
 */
export function providerOfCredential(name: string, remote: RemoteUrl): Provider | null {
  switch (name.trim().toLowerCase()) {
    case 'github':
      return 'github';
    case 'gitlab':
      return 'gitlab';
    case 'bitbucket':
      return remote.host === 'bitbucket.org' ? 'bitbucket' : 'bitbucket-server';
    case 'azure-repos':
      return 'azure-devops';
    default:
      return null;
  }
}

/** `weft.remoteHosts` as far as it can be used: hosts, lowercased, each named as a kind Weft knows. */
export function readRemoteHosts(value: unknown): Readonly<Record<string, Provider>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const hosts: Record<string, Provider> = {};

  for (const [host, provider] of Object.entries(value)) {
    const known = PROVIDERS.find((name) => name === provider);

    if (known !== undefined) {
      hosts[host.trim().toLowerCase()] = known;
    }
  }

  return hosts;
}

/** The repository's own page. */
export function repoPage(provider: Provider, remote: RemoteUrl): string {
  const site = `${remote.scheme}://${remote.host}`;

  if (provider === 'bitbucket-server') {
    // Cloned from .../scm/PROJ/repo, or over ssh from PROJ/repo; browsed at .../projects/PROJ/repos/repo.
    // A personal repository's project is ~user, and its page is under users/.
    const scm = /^(?:(.+)\/)?scm\/([^/]+)\/([^/]+)$/.exec(remote.path) ?? /^()([^/]+)\/([^/]+)$/.exec(remote.path);

    if (scm !== null) {
      const [, context = '', project = '', name = ''] = scm;
      const owner = project.startsWith('~') ? `users/${project.slice(1)}` : `projects/${project}`;
      return `${site}/${context === '' ? '' : `${context}/`}${owner}/repos/${name}`;
    }
  }

  return `${site}/${remote.path}`;
}

/** A commit's page. */
export function commitPage(provider: Provider, page: string, sha: string): string {
  switch (provider) {
    case 'gitlab':
      return `${page}/-/commit/${sha}`;
    case 'bitbucket':
    case 'bitbucket-server':
      return `${page}/commits/${sha}`;
    default:
      return `${page}/commit/${sha}`;
  }
}

/**
 * A branch's or a tag's page. A name's slashes stay slashes where the server reads the name as a
 * path - `release/v1.3` is two segments on GitLab, and the page is found - and everything else in it
 * is encoded, so a `#` in a branch name is part of the name and not the start of a fragment.
 */
export function refPage(provider: Provider, page: string, kind: 'branch' | 'tag', name: string): string {
  const path = name.split('/').map(encodeURIComponent).join('/');

  switch (provider) {
    case 'github':
      return `${page}/tree/${path}`;
    case 'gitlab':
      return `${page}/-/tree/${path}`;
    case 'gitea':
      return `${page}/src/${kind}/${path}`;
    case 'bitbucket':
      return kind === 'branch' ? `${page}/branch/${path}` : `${page}/src/${encodeURIComponent(name)}`;
    case 'bitbucket-server':
      return `${page}/browse?at=${encodeURIComponent(`refs/${kind === 'branch' ? 'heads' : 'tags'}/${name}`)}`;
    case 'azure-devops':
      return `${page}?version=${kind === 'branch' ? 'GB' : 'GT'}${encodeURIComponent(name)}`;
  }
}
