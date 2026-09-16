/**
 * Web addresses from remote URLs: taking a URL apart, telling what serves it, and each kind of
 * server's addresses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { RemoteUrl } from '../src/git/webLinks.ts';
import {
  commitPage,
  filePage,
  parseRemoteUrl,
  providerOf,
  providerOfCredential,
  readRemoteHosts,
  refPage,
  repoPage,
} from '../src/git/webLinks.ts';

const at = (url: string): RemoteUrl => {
  const remote = parseRemoteUrl(url);
  assert.notEqual(remote, null, `${url} should be a server's`);
  return remote as RemoteUrl;
};

test('a remote URL is taken apart the way its site is addressed', () => {
  assert.deepEqual(parseRemoteUrl('http://10.20.30.40/erp/dlp.git'), { scheme: 'http', host: '10.20.30.40', path: 'erp/dlp' });
  assert.deepEqual(parseRemoteUrl('https://me@GitHub.com/owner/repo.git/'), { scheme: 'https', host: 'github.com', path: 'owner/repo' });
  assert.deepEqual(parseRemoteUrl('https://git.example.com:8443/group/sub/project.git'), {
    scheme: 'https',
    host: 'git.example.com:8443',
    path: 'group/sub/project',
  });
  assert.deepEqual(parseRemoteUrl('http://git.example.com:80/a/b'), { scheme: 'http', host: 'git.example.com', path: 'a/b' });
  assert.deepEqual(parseRemoteUrl('git@gitlab.com:group/project.git'), { scheme: 'https', host: 'gitlab.com', path: 'group/project' });
  assert.deepEqual(parseRemoteUrl('ssh://git@code.example.com:7999/PROJ/repo.git'), {
    scheme: 'https',
    host: 'code.example.com',
    path: 'PROJ/repo',
  });
  assert.deepEqual(parseRemoteUrl('ssh://git@ssh.github.com:443/owner/repo.git'), { scheme: 'https', host: 'github.com', path: 'owner/repo' });
  assert.deepEqual(parseRemoteUrl('git@ssh.dev.azure.com:v3/org/project/repo'), {
    scheme: 'https',
    host: 'dev.azure.com',
    path: 'org/project/_git/repo',
  });

  for (const local of ['/srv/git/repo.git', 'C:/repos/repo', 'C:\\repos\\repo', 'file:///srv/git/repo.git', '../repo', '']) {
    assert.equal(parseRemoteUrl(local), null, `${local} is not on a server`);
  }
});

test('what serves a remote is read from the setting, then the host, then the path', () => {
  const dlp = at('http://10.20.30.40/erp/dlp.git');

  assert.equal(providerOf(dlp, {}), null, 'nothing in an address like this one says');
  assert.equal(providerOf(dlp, { '10.20.30.40': 'gitlab' }), 'gitlab');
  assert.equal(providerOf(at('https://git.example.com:8443/a/b.git'), { 'git.example.com': 'gitea' }), 'gitea', 'a host named without its port');
  assert.equal(providerOf(at('https://github.com/o/r'), { 'github.com': 'gitlab' }), 'gitlab', 'the setting over what the host is known to be');
  assert.equal(providerOf(at('git@github.com:o/r.git'), {}), 'github');
  assert.equal(providerOf(at('https://org.visualstudio.com/project/_git/repo'), {}), 'azure-devops');
  assert.equal(providerOf(at('https://gitlab.example.com/a/b.git'), {}), 'gitlab');
  assert.equal(providerOf(at('https://bitbucket.example.com/scm/PROJ/repo.git'), {}), 'bitbucket-server');
  assert.equal(providerOf(at('https://code.example.com/scm/PROJ/repo.git'), {}), 'bitbucket-server');
  assert.equal(providerOf(at('https://tfs.example.com/tfs/Collection/Project/_git/Repo'), {}), 'azure-devops');
});

test("Git Credential Manager's provider names a server nothing else does", () => {
  const dlp = at('http://10.20.30.40/erp/dlp.git');

  assert.equal(providerOfCredential('gitlab\n', dlp), 'gitlab');
  assert.equal(providerOfCredential('azure-repos', dlp), 'azure-devops');
  assert.equal(providerOfCredential('bitbucket', dlp), 'bitbucket-server');
  assert.equal(providerOfCredential('bitbucket', at('https://bitbucket.org/o/r.git')), 'bitbucket');
  assert.equal(providerOfCredential('generic', dlp), null);
  assert.equal(providerOfCredential('', dlp), null);
});

test('only kinds of server Weft knows are taken from the setting', () => {
  assert.deepEqual(readRemoteHosts({ 'Git.Example.com': 'gitlab', 'x.example.com': 'sourceforge', 'y.example.com': 3 }), {
    'git.example.com': 'gitlab',
  });
  assert.deepEqual(readRemoteHosts(['gitlab']), {});
  assert.deepEqual(readRemoteHosts(null), {});
});

test("each server's addresses, in the remote's own scheme, keeping a branch name's slashes", () => {
  const page = repoPage('gitlab', at('http://10.20.30.40/erp/dlp.git'));

  assert.equal(page, 'http://10.20.30.40/erp/dlp');
  assert.equal(commitPage('gitlab', page, 'abc123'), 'http://10.20.30.40/erp/dlp/-/commit/abc123');
  assert.equal(refPage('gitlab', page, 'branch', 'release/v1.3'), 'http://10.20.30.40/erp/dlp/-/tree/release/v1.3');
  assert.equal(refPage('gitlab', page, 'branch', 'fix#12 now'), 'http://10.20.30.40/erp/dlp/-/tree/fix%2312%20now');

  assert.equal(commitPage('github', 'https://github.com/o/r', 'abc'), 'https://github.com/o/r/commit/abc');
  assert.equal(refPage('github', 'https://github.com/o/r', 'tag', 'v1.0'), 'https://github.com/o/r/tree/v1.0');
  assert.equal(refPage('gitea', 'https://codeberg.org/o/r', 'tag', 'v1.0'), 'https://codeberg.org/o/r/src/tag/v1.0');
  assert.equal(commitPage('bitbucket', 'https://bitbucket.org/o/r', 'abc'), 'https://bitbucket.org/o/r/commits/abc');
  assert.equal(refPage('bitbucket', 'https://bitbucket.org/o/r', 'branch', 'feature/x'), 'https://bitbucket.org/o/r/branch/feature/x');

  const server = repoPage('bitbucket-server', at('https://code.example.com/scm/PROJ/repo.git'));
  assert.equal(server, 'https://code.example.com/projects/PROJ/repos/repo');
  assert.equal(repoPage('bitbucket-server', at('ssh://git@code.example.com:7999/~me/repo.git')), 'https://code.example.com/users/me/repos/repo');
  assert.equal(
    refPage('bitbucket-server', server, 'branch', 'feature/x'),
    'https://code.example.com/projects/PROJ/repos/repo/browse?at=refs%2Fheads%2Ffeature%2Fx',
  );

  const azure = repoPage('azure-devops', at('git@ssh.dev.azure.com:v3/org/project/repo'));
  assert.equal(azure, 'https://dev.azure.com/org/project/_git/repo');
  assert.equal(commitPage('azure-devops', azure, 'abc'), 'https://dev.azure.com/org/project/_git/repo/commit/abc');
  assert.equal(refPage('azure-devops', azure, 'branch', 'feature/x'), 'https://dev.azure.com/org/project/_git/repo?version=GBfeature%2Fx');
});

test("a file's page is pinned to the commit, and opens at the lines it was given", () => {
  const page = 'http://10.20.30.40/erp/dlp';
  const sha = 'abc123';
  const one = { from: 12, to: 12 };
  const range = { from: 12, to: 20 };

  assert.equal(filePage('gitlab', page, sha, 'src/app.ts', null), `${page}/-/blob/${sha}/src/app.ts`);
  assert.equal(filePage('gitlab', page, sha, 'src/app.ts', one), `${page}/-/blob/${sha}/src/app.ts#L12`);
  assert.equal(filePage('gitlab', page, sha, 'src/app.ts', range), `${page}/-/blob/${sha}/src/app.ts#L12-20`);

  const github = 'https://github.com/o/r';

  assert.equal(filePage('github', github, sha, 'src/app.ts', range), `${github}/blob/${sha}/src/app.ts#L12-L20`);
  assert.equal(filePage('gitea', 'https://codeberg.org/o/r', sha, 'a/b.ts', one), `https://codeberg.org/o/r/src/commit/${sha}/a/b.ts#L12`);
  assert.equal(filePage('bitbucket', 'https://bitbucket.org/o/r', sha, 'a/b.ts', range), `https://bitbucket.org/o/r/src/${sha}/a/b.ts#lines-12:20`);
  assert.equal(
    filePage('bitbucket-server', 'https://git.example.com/projects/PROJ/repos/repo', sha, 'a/b.ts', range),
    `https://git.example.com/projects/PROJ/repos/repo/browse/a/b.ts?at=${sha}#12-20`,
  );
  assert.equal(
    filePage('azure-devops', 'https://dev.azure.com/org/project/_git/repo', sha, 'a/b.ts', one),
    `https://dev.azure.com/org/project/_git/repo?path=%2Fa%2Fb.ts&version=GC${sha}&line=12&lineEnd=12&lineStartColumn=1&lineEndColumn=1`,
  );

  // A path is encoded a segment at a time, so its slashes stay slashes and everything else is spelled out.
  assert.equal(filePage('gitlab', page, sha, 'src/a b/c#d.ts', null), `${page}/-/blob/${sha}/src/a%20b/c%23d.ts`);
});
