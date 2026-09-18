/*
 * The UI probe's page script: drives the webview, and records what it builds and what it sends.
 *
 * Injected verbatim by scripts/ui-probe.mjs, after main.js, into a copy of dist/preview.html that
 * replays a real repository's history. A plain file rather than a string inside the runner, which
 * is what it used to be: a template literal, where every backslash had to be doubled and a single
 * backtick in a comment ended the script.
 *
 * The recording goes into a pre element appended at the very end of the page, as sections headed
 * `=== name ===`. The runner compares whole recordings between builds, and holds a few sections to
 * invariants in npm test.
 *
 * Three rules, each learnt from a recording that passed while proving nothing:
 * - Toggling controls are driven by their state, never by blind clicks. The branch button toggles,
 *   and a click meant to open it closed a menu an earlier step had left open.
 * - Rows are queried fresh, never held. Every repaint rebuilds them, and a held row is a detached
 *   element that still carries its own click listener - so it half-works.
 * - What only the host drives runs last. A reset throws the history away, and every section before
 *   it depends on the rows.
 */
(async () => {
  const parts = [];

  try {
    const settle = (ms) => new Promise((done) => setTimeout(done, ms));
    const click = (el, type) =>
      el && el.dispatchEvent(new MouseEvent(type || 'click', { bubbles: true, clientX: 40, clientY: 60 }));
    const fire = (el, type) => el && el.dispatchEvent(new Event(type, { bubbles: true }));

    /*
     * What the page has asked the host for, which is the only way to tell a filter from a checkout:
     * the host owns the drawn set, so in this harness nothing on screen moves either way.
     */
    const sent = () => window.__sent || [];
    const sentSince = (count) => sent().slice(count).map((m) => JSON.stringify(m)).join('\n');

    const menuShut = () => document.querySelector('#branch-list').hidden;
    const openMenu = async () => {
      if (menuShut()) click(document.querySelector('#branch-button'));
      await settle(300);
    };
    const shutMenu = async () => {
      if (!menuShut()) click(document.querySelector('#branch-button'));
      await settle(200);
    };

    const take = (name, el) => parts.push('=== ' + name + ' ===\n' + (el ? el.innerHTML : '(missing)'));

    /*
     * A control's own state, which is not in its innerHTML: what it holds, whether it is shown, and
     * what it says. The text matters for the header's status - "still walking", "nothing to draw"
     * and git's own error are three sentences in one element, and telling them apart is the point.
     */
    const state = (name, selector) => {
      const el = document.querySelector(selector);
      parts.push(
        '=== ' + name + ' ===\n' +
          (el
            ? [...el.attributes].map((a) => a.name + '=' + JSON.stringify(a.value)).sort().join(' ') +
              ' value=' + JSON.stringify(el.value === undefined ? '' : el.value) +
              ' hidden=' + el.hidden +
              ' text=' + JSON.stringify((el.textContent || '').slice(0, 200))
            : '(missing)'),
      );
    };

    /** The search switches say four things each, none of them in the markup. */
    const toggles = (name) => {
      parts.push(
        '=== ' + name + ' ===\n' +
          [...document.querySelectorAll('#search-toggles .toggle')]
            .map((b) =>
              [
                b.dataset.toggle,
                b.hidden ? 'hidden' : 'shown',
                b.disabled ? 'locked' : 'live',
                b.classList.contains('on') ? 'on' : 'off',
                b.title,
              ].join(' '),
            )
            .join('\n'),
      );
    };

    /** The branch menu's rows as they read: a tick, a name, and the headings between them. */
    const listed = () =>
      [...document.querySelectorAll('#branch-rows > *')]
        .map((el) => {
          const name = el.querySelector('.branch-name');

          if (el.classList.contains('branch-folder')) {
            return '(folder) ' + (el.textContent || '').trim();
          }

          if (name === null) {
            return '(group) ' + (el.textContent || '').trim();
          }

          return ((el.querySelector('.branch-draw') || {}).checked ? '[x] ' : '[ ] ') + name.textContent;
        })
        .join('\n');

    await settle(1200);

    /*
     * The badges the came-from filter puts on a row: which branch it arrived from, and which of the two
     * ways. First, because everything below this either replays the history or empties it.
     */
    {
      const badges = [...document.querySelectorAll('#rows .ref.came-from')].map(
        (el) => el.className + ' | ' + el.textContent + ' | ' + el.title.slice(0, 40),
      );

      parts.push('=== came-from badges ===\n' + (badges.join('\n') || '(none)'));

      /*
       * And whether anything on a row was cut short. A browser says so by holding more than it shows:
       * `scrollWidth` past `clientWidth` is an ellipsis, whatever put it there - a max-width, a flex
       * that gave way, or a column somebody dragged narrow. Every badge on screen, not only these two,
       * because a ref's name is a name as much as this is.
       */
      const cut = (el) => el.scrollWidth > el.clientWidth + 1;
      const badgesCut = [...document.querySelectorAll('#rows .ref')].filter(cut).map((el) => el.textContent);
      const subjects = [...document.querySelectorAll('#rows .subject')];

      parts.push(
        '=== what was cut short ===\nbadges cut: ' +
          JSON.stringify(badgesCut) +
          '\nsubjects cut: ' +
          subjects.filter(cut).length +
          ' of ' +
          subjects.length,
      );
    }

    // The branch dropdown, and the ref rows inside it.
    await openMenu();
    take('branch menu', document.querySelector('#branch-menu'));

    // A name is the tick's label: clicking it asks for a filter, never a checkout.
    const beforeName = sent().length;
    click(document.querySelector('#branch-menu .branch-name'));
    await settle(250);
    parts.push('=== clicking a branch name sends ===\n' + sentSince(beforeName));

    const beforeTick = sent().length;
    click(document.querySelector('#branch-menu .branch-row .branch-draw'));
    await settle(250);
    parts.push('=== clicking the row tick sends ===\n' + sentSince(beforeTick));

    // The quick-switch list, which builds its own rows.
    const jump = document.querySelector('#branch-jump');

    if (jump) {
      jump.value = 'f';
      fire(jump, 'input');
    }

    await settle(250);
    take('jump list', document.querySelector('#jump-list'));

    // The box beside the menu, which is the one gesture here that switches branch.
    const beforeJump = sent().length;
    click([...document.querySelectorAll('#jump-list .jump-name')].find((row) => !row.disabled));
    await settle(250);
    parts.push('=== clicking a quick-switch row sends ===\n' + sentSince(beforeJump));

    /*
     * The row that was reported: a remote whose label is the branch you are already on. The old
     * code disabled the row for the branch you are on, and that test was kind === 'local' - so the
     * remote of the same name stayed live, and clicking it asked to check out a branch already
     * checked out. The demo repository has no remote, so one is posted in.
     */
    window.postMessage(
      {
        type: 'refs',
        branch: 'main',
        refs: [
          { label: 'main', refName: 'refs/heads/main', kind: 'local', visible: true, updated: 0 },
          { label: 'main', refName: 'refs/remotes/origin/main', kind: 'remote', visible: true, updated: 0 },
        ],
      },
      '*',
    );
    await settle(200);

    await openMenu();
    take('branch menu with a remote of the same name', document.querySelector('#branch-menu'));

    const beforeRemote = sent().length;
    const remoteRow = [...document.querySelectorAll('#branch-menu .branch-row')].find((row) =>
      ((row.querySelector('.branch-name') || {}).title || '').includes('refs/remotes/'),
    );
    click(remoteRow && remoteRow.querySelector('.branch-name'));
    await settle(250);
    parts.push('=== clicking the remote row of the branch you are on sends ===\n' + sentSince(beforeRemote));

    /*
     * Presets, as chips above the list: a click on one draws it, and Save asks the host. The demo
     * repository has none saved, so one is posted in.
     */
    window.postMessage(
      {
        type: 'refs',
        branch: 'main',
        refs: [{ label: 'main', refName: 'refs/heads/main', kind: 'local', visible: true, updated: 0 }],
        presets: [{ name: 'release work', describes: '3 refs' }],
      },
      '*',
    );
    await settle(200);

    await openMenu();
    take('branch presets', document.querySelector('#branch-presets'));

    const beforePreset = sent().length;
    click(document.querySelector('#branch-presets .branch-preset[data-preset]'));
    await settle(250);
    click(document.querySelector('#branch-presets .branch-preset[data-action="save"]'));
    await settle(250);
    parts.push('=== clicking a preset, then Save, sends ===\n' + sentSince(beforePreset));

    /*
     * A long list with a few ticked, which is the reported case: ticking one in the middle of a
     * hundred and fifty alphabetical rows was the last you saw of it. The ticked ones are scattered -
     * two near the start, one at the very end - so "they went to the top" cannot be satisfied by the
     * list happening to be in that order already.
     */
    const many = [];

    for (let i = 0; i < 24; i++) {
      const name = 'Dev_ACB' + String(100 + i) + 'CAVN';
      many.push({ label: name, refName: 'refs/heads/' + name, kind: 'local', visible: i === 3 || i === 7 || i === 23, updated: 0 });
    }

    // And remotes, which is where the first attempt fell down: floated within their own group, a
    // ticked remote sat under every local branch there is.
    many.push(
      { label: 'release/v1.3', refName: 'refs/heads/release/v1.3', kind: 'local', visible: true, updated: 0 },
      { label: 'origin/release/v1.3', refName: 'refs/remotes/origin/release/v1.3', kind: 'remote', visible: true, updated: 0 },
      { label: 'origin/uat', refName: 'refs/remotes/origin/uat', kind: 'remote', visible: true, updated: 0 },
      { label: 'origin/quiet', refName: 'refs/remotes/origin/quiet', kind: 'remote', visible: false, updated: 0 },
    );

    window.postMessage({ type: 'refs', branch: 'main', refs: many }, '*');
    await settle(200);

    await openMenu();
    parts.push('=== a long list, ticked first ===\n' + listed());

    /*
     * Ticking one while the menu is open: it joins Drawn straight away. The section answers "what is
     * the graph drawing", and holding it still until the menu reopened made it say one when three
     * were drawn.
     */
    const rows = [...document.querySelectorAll('#branch-rows .branch-row')];
    const target = rows[rows.length - 1];
    // By its ref rather than its text: a row inside a folder reads as the rest of its name.
    const targetRef = target.querySelector('.branch-name').title.split('\n')[0];
    const box = target.querySelector('.branch-draw');

    box.checked = true;
    fire(box, 'change');
    await settle(200);

    // The host answers a tick by sending the list back, which is what redraws the menu.
    window.postMessage(
      { type: 'refs', branch: 'main', refs: many.map((r) => (r.refName === targetRef ? { ...r, visible: true } : r)) },
      '*',
    );
    await settle(300);

    state('is the menu still open', '#branch-list');
    parts.push('=== after ticking a row, with the menu still open ===\n' + listed());

    await shutMenu();
    await openMenu();
    parts.push('=== and again after closing and opening it ===\n' + listed());

    /*
     * Folders: Dev_a and Dev_b fold into a Dev_ folder, closed until opened, and Fix_c, the only Fix_,
     * stays on its own. The filter is emptied first, since text in it opens every folder there is.
     */
    window.postMessage(
      {
        type: 'refs',
        branch: 'main',
        refs: ['main', 'Dev_a', 'Dev_b', 'Fix_c'].map((label) => ({
          label,
          refName: 'refs/heads/' + label,
          kind: 'local',
          visible: label === 'main',
          updated: 0,
        })),
        presets: [],
        folders: 'auto',
      },
      '*',
    );
    await settle(200);

    const folderFilter = document.querySelector('#branch-filter');
    folderFilter.value = '';
    fire(folderFilter, 'input');
    await openMenu();
    parts.push('=== branch folders, closed ===\n' + listed());

    click(document.querySelector('#branch-rows .branch-folder-toggle'));
    await settle(200);
    parts.push('=== branch folders, one opened ===\n' + listed());

    /*
     * A comparison's commits, a side each, and the click that draws a branch the graph is not drawing.
     * Posted in as the host answers, with uat undrawn and more commits on it than the list holds.
     */
    window.postMessage(
      {
        type: 'comparison',
        from: { rev: 'refs/heads/main', label: 'main', sha: 'a'.repeat(40), drawn: true },
        to: { rev: 'refs/remotes/origin/uat', label: 'origin/uat', sha: 'b'.repeat(40), drawn: false },
        files: 3,
        onlyFrom: 0,
        onlyTo: 250,
        onlyFromCommits: [],
        onlyToCommits: [
          { sha: 'c'.repeat(40), subject: 'the newest on uat', author: 'Weft Test', date: 0 },
          { sha: 'd'.repeat(40), subject: 'the one before it', author: 'Weft Test', date: 0 },
        ],
      },
      '*',
    );
    await settle(250);
    take('comparison commits', document.querySelector('#detail-commits'));

    const beforeDraw = sent().length;
    click(document.querySelector('#detail-commits .side-draw'));
    await settle(200);
    parts.push('=== drawing the undrawn end of a comparison sends ===\n' + sentSince(beforeDraw));

    /*
     * And let go of, so the steps after this one start with nothing marked - a branch's menu offers
     * Select for Compare only while no comparison holds it. Escape closes the innermost thing open
     * first, and the branch menu opened above is still up, so it can take more than one.
     */
    for (let i = 0; i < 3 && !document.querySelector('#compare-mark').hidden; i += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(100);
    }

    // The right-click menu on a commit row. The host answers that one, so the answer is posted
    // directly - which is what the menu is given either way.
    window.postMessage(
      {
        type: 'menu',
        target: { kind: 'commit', sha: 'c91023ecc8178d63e2fe8c531df525db8096b546', subject: 'Say when the walk stopped at the limit' },
        items: [
          { id: 'weft.checkoutCommit', label: 'Checkout Commit…', group: 'checkout', destructive: false, disabledReason: null },
          { id: 'weft.createBranch', label: 'Create Branch…', group: 'branch', destructive: false, disabledReason: null },
          { id: 'weft.cherryPick', label: 'Cherry-pick', group: 'apply', destructive: false, disabledReason: 'a merge has more than one side' },
          { id: 'weft.resetHard', label: 'Reset (hard)', group: 'reset', destructive: true, disabledReason: null },
        ],
        x: 40,
        y: 60,
      },
      '*',
    );
    await settle(250);
    take('row menu', document.querySelector('.menu'));

    // And the one on the column headers.
    const columns = document.querySelector('#columns');

    if (columns) {
      columns.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 10 }));
    }

    await settle(250);
    take('column menu', [...document.querySelectorAll('.menu')].pop());
    document.querySelectorAll('.menu').forEach((m) => m.remove());

    take('columns', document.querySelector('#columns'));
    take('header', document.querySelector('#header'));

    /*
     * The filter bar. Everything here is state rather than markup - which switches a mode offers,
     * which it locks, what the rows mark up and where the marks land.
     */
    const input = document.querySelector('#search-input');
    const mode = document.querySelector('#search-mode');

    toggles('toggles at rest');
    state('mode at rest', '#search-mode');

    // A word the demo history contains, so there is something to mark.
    input.value = 'lane';
    fire(input, 'input');
    await settle(500);
    take('rows marked on message', document.querySelector('#rows'));

    // Author mode marks a different column and offers different switches.
    mode.value = 'author';
    fire(mode, 'change');
    await settle(400);
    toggles('toggles in author mode');
    state('mode in author mode', '#search-mode');
    take('rows marked on author', document.querySelector('#rows'));

    // A regular expression, which is the other highlight dialect.
    const regex = document.querySelector('.toggle[data-toggle="regex"]');
    mode.value = 'message';
    fire(mode, 'change');
    input.value = 'a.a';
    fire(input, 'input');
    click(regex);
    await settle(500);
    toggles('toggles with regex on');
    take('rows marked on a pattern', document.querySelector('#rows'));

    // An unparseable pattern turns the marking off rather than the search.
    input.value = 'a(';
    fire(input, 'input');
    await settle(500);
    take('rows with a broken pattern', document.querySelector('#rows'));
    click(regex);

    // Path mode with follow on locks a switch rather than hiding it.
    mode.value = 'path';
    fire(mode, 'change');
    await settle(300);
    toggles('toggles in path mode');
    click(document.querySelector('.toggle[data-toggle="follow"]'));
    await settle(300);
    toggles('toggles following renames');

    // And off again: the lock goes, and the case switch has to say what it does again.
    click(document.querySelector('.toggle[data-toggle="follow"]'));
    await settle(300);
    toggles('toggles after following is switched off');

    // The date filter: picking custom opens a row that is not itself a filter.
    const range = document.querySelector('#date-range');
    range.value = 'custom';
    fire(range, 'change');
    await settle(300);
    state('date custom opened', '#date-custom');
    state('date range', '#date-range');

    const since = document.querySelector('#date-since');
    since.value = '2024-03-01';
    fire(since, 'change');
    await settle(300);
    state('date custom with a bound', '#date-custom');
    state('date since', '#date-since');

    // And the cross that puts it back.
    click(document.querySelector('#date-close'));
    await settle(300);
    state('date custom cleared', '#date-custom');
    state('date range cleared', '#date-range');

    // The two the host drives rather than the reader, each putting every control somewhere specific.
    window.postMessage({ type: 'showHistory', path: 'src/webview/graph.ts' }, '*');
    await settle(400);
    state('history: mode', '#search-mode');
    state('history: query', '#search-input');
    state('history: date range', '#date-range');
    toggles('history: toggles');

    // Something to clear: a query, a mode, switches, a date and both of the header's own filters.
    input.value = 'lane';
    fire(input, 'input');
    mode.value = 'message';
    fire(mode, 'change');
    click(document.querySelector('.toggle[data-toggle="invert"]'));
    range.value = '7';
    fire(range, 'change');
    click(document.querySelector('#first-parent'));
    click(document.querySelector('#only-here'));
    await settle(400);
    state('before clearing: query', '#search-input');
    state('before clearing: date range', '#date-range');
    toggles('before clearing: toggles');
    state('before clearing: first parent', '#first-parent');
    state('before clearing: only here', '#only-here');

    window.postMessage({ type: 'filtersCleared' }, '*');
    await settle(400);
    state('cleared: query', '#search-input');
    state('cleared: mode', '#search-mode');
    state('cleared: date range', '#date-range');
    state('cleared: date custom', '#date-custom');
    toggles('cleared: toggles');
    state('cleared: first parent', '#first-parent');
    state('cleared: only here', '#only-here');
    take('cleared: rows', document.querySelector('#rows'));

    /*
     * The pane along the bottom. Three different things go in it and none is a variation on the
     * others, so all three are asked for - the host answers two, so their answers are posted.
     */
    window.postMessage(
      {
        type: 'details',
        details: {
          sha: 'c91023ecc8178d63e2fe8c531df525db8096b546',
          parents: ['3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a', '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b'],
          author: 'Ada Fischer',
          authorEmail: 'ada@example.com',
          authorDate: '2025-11-07T17:30:00+00:00',
          committer: 'Nils Berg',
          committerDate: '2025-11-08T09:15:00+00:00',
          body: 'Say when the walk stopped at the limit\n\nThe limit guards against a runaway walk. It was silent,\nwhich made a truncated graph look like a complete one.',
        },
      },
      '*',
    );
    await settle(400);
    take('pane: a commit', document.querySelector('#details'));
    state('pane: shown', '#details');

    /*
     * A branch compared by its name, off its badge on a row: the badge's menu takes the first step and
     * another row's menu the second. What goes to the host is the branch rather than the commit it is
     * on, so it is compared as it is when the comparison runs.
     */
    const lastMenu = () => [...document.querySelectorAll('.menu')].pop();
    const menuItem = (label) =>
      [...((lastMenu() || document).querySelectorAll('.menu-item'))].find((el) => el.textContent === label);
    const badge = document.querySelector('#rows .row .ref.local');
    const branch = badge ? badge.textContent : '(no branch badge)';

    click(badge, 'contextmenu');
    await settle(250);
    take('a branch badge menu', lastMenu());
    click(menuItem('Select for Compare'));
    await settle(250);
    state('mark: a branch selected', '#compare-mark');

    click(document.querySelector('#rows .row:not(.uncommitted):not(.compare-anchor)'), 'contextmenu');
    await settle(250);
    const beforeCompare = sent().length;
    click(menuItem('Compare with ' + branch));
    await settle(250);
    parts.push('=== comparing a row with the marked branch sends ===\n' + sentSince(beforeCompare));

    // The host's answer names both ends as they were asked for - two branches, this time.
    window.postMessage(
      {
        type: 'comparison',
        from: { rev: 'refs/heads/main', label: 'main', sha: 'c91023ecc8178d63e2fe8c531df525db8096b546', drawn: true },
        to: { rev: 'refs/remotes/origin/uat', label: 'origin/uat', sha: '3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a', drawn: true },
        files: 7,
        onlyFrom: 3,
        onlyTo: 2,
        // Every commit on each side, so neither list says it is the newest few of more.
        onlyFromCommits: [
          { sha: '1'.repeat(40), subject: 'the newest on main', author: 'Weft Test', date: 0 },
          { sha: '2'.repeat(40), subject: 'the one before it', author: 'Weft Test', date: 0 },
          { sha: '3'.repeat(40), subject: 'the oldest on main', author: 'Weft Test', date: 0 },
        ],
        onlyToCommits: [
          { sha: '4'.repeat(40), subject: 'the newest on uat', author: 'Weft Test', date: 0 },
          { sha: '5'.repeat(40), subject: 'the oldest on uat', author: 'Weft Test', date: 0 },
        ],
      },
      '*',
    );
    await settle(400);
    take('pane: a comparison', document.querySelector('#details'));
    state('mark: a comparison', '#compare-mark');

    /*
     * Escape goes innermost first - the branch menu opened above, which is still up, then the
     * comparison, then the pane. So the menu is dismissed and the comparison dropped here, or the
     * pane's own Escape below closes one of those and the pane never moves.
     */
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 700, clientY: 400 }));
    await settle(200);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(300);
    state('mark: dropped by Escape', '#compare-mark');

    // The working-tree row, the third shape: no hash, no author, no message.
    click(document.querySelector('#rows .row.uncommitted'));
    await settle(400);
    take('pane: the working tree', document.querySelector('#details'));

    // On a commit, because that is what the reopen was written for: the working tree holds none.
    const commitRow = () => document.querySelector('#rows .row:not(.uncommitted)');

    click(commitRow());
    await settle(200);
    window.postMessage(
      {
        type: 'details',
        details: {
          sha: 'c91023ecc8178d63e2fe8c531df525db8096b546',
          parents: ['3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a'],
          author: 'Ada Fischer',
          authorEmail: 'ada@example.com',
          authorDate: '2025-11-07T17:30:00+00:00',
          committer: 'Ada Fischer',
          committerDate: '2025-11-07T17:30:00+00:00',
          body: 'Say when the walk stopped at the limit',
        },
      },
      '*',
    );
    await settle(300);
    state('pane: holding a commit', '#details');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(300);
    state('pane: closed', '#details');

    // Clicking the row that is already selected is how the pane is asked for again.
    click(commitRow());
    await settle(300);
    state('pane: reopened', '#details');

    /*
     * Dragging the sash. The canvas is sized to what the pane leaves, so a height that moves without
     * a repaint leaves the lanes at the old size - visible only in the canvas' own attributes.
     */
    state('canvas before the drag', '#graph');

    const sash = document.querySelector('#splitter');
    const drag = (type, y) => sash.dispatchEvent(new PointerEvent(type, { bubbles: true, clientY: y, pointerId: 1 }));

    // setPointerCapture throws on a synthetic pointer; the drag does not need it to work.
    sash.setPointerCapture = () => undefined;
    drag('pointerdown', 500);
    drag('pointermove', 420);
    await settle(300);
    state('pane after dragging up', '#details');
    state('canvas after the drag', '#graph');

    drag('pointerup', 420);
    await settle(200);
    state('sash when let go', '#splitter');

    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle(300);
    state('pane after resetting the sash', '#details');

    /*
     * What the header says about what is going on - last, because the end of it throws the history
     * away. The demo repository has no remote and nothing in progress, so none of this happens on
     * its own: the harness replays a "working" with no upstream and never an "operation".
     */
    state('empty: with rows on screen', '#empty');

    const upstream = (ahead, behind, gone, minutesAgo) => {
      window.postMessage(
        {
          type: 'working',
          total: 2,
          staged: 0,
          unstaged: 1,
          untracked: 1,
          conflicted: 0,
          branch: 'main',
          upstream: { ref: 'origin/main', ahead, behind, gone },
          fetchedAt: Date.now() - minutesAgo * 60_000,
        },
        '*',
      );
    };

    upstream(2, 3, false, 12);
    await settle(350);
    take('upstream: ahead and behind', document.querySelector('#upstream'));
    state('upstream: shown', '#upstream');

    upstream(0, 0, false, 200);
    await settle(350);
    take('upstream: level, three hours ago', document.querySelector('#upstream'));

    upstream(1, 0, true, 0);
    await settle(350);
    take('upstream: gone from the remote', document.querySelector('#upstream'));

    window.postMessage(
      {
        type: 'operation',
        operation: 'merge',
        description: 'a merge',
        conflicted: ['src/webview/main.ts', 'CHANGELOG.md'],
        controls: [
          { id: 'weft.continueOperation', label: 'Continue', group: 'operation', destructive: false, disabledReason: 'Resolve the conflicts first' },
          { id: 'weft.abortOperation', label: 'Abort', group: 'danger', destructive: true, disabledReason: null },
        ],
      },
      '*',
    );
    await settle(350);
    take('banner: a conflicted merge', document.querySelector('#operation'));

    window.postMessage({ type: 'operation', operation: 'none', description: '', conflicted: [], controls: [] }, '*');
    await settle(300);
    state('banner: nothing in progress', '#operation');

    // A reload waits a quarter of a second before admitting to it, so the sentence is taken twice.
    window.postMessage({ type: 'reset', filtered: false }, '*');
    await settle(80);
    state('busy: before it admits to it', '#empty');
    state('busy: the bar, before', '#progress');

    await settle(500);
    state('busy: once it has waited', '#empty');
    state('busy: the bar, after', '#progress');

    // A page landing mid-walk takes the sentence away with it.
    window.postMessage(
      {
        type: 'page',
        rows: [
          {
            sha: 'c91023ecc8178d63e2fe8c531df525db8096b546',
            subject: 'Say when the walk stopped at the limit',
            author: 'Ada Fischer',
            date: '2025-11-07T17:30:00+00:00',
            refs: [],
            isHead: false,
          },
        ],
        delta: { firstRow: 0, dots: [], links: [], paths: [], width: 0, widths: [0] },
      },
      '*',
    );
    await settle(300);
    state('empty: a page landed mid-walk', '#empty');

    // An empty repository, a filter that matches nothing and a failed walk each say their own thing.
    window.postMessage({ type: 'reset', filtered: false }, '*');
    window.postMessage({ type: 'done', total: 0, elapsedMs: 0 }, '*');
    await settle(300);
    state('empty: nothing to draw', '#empty');

    window.postMessage({ type: 'reset', filtered: true }, '*');
    window.postMessage({ type: 'done', total: 0, elapsedMs: 0 }, '*');
    await settle(300);
    state('empty: narrowed to nothing', '#empty');

    window.postMessage({ type: 'reset', filtered: false }, '*');
    window.postMessage({ type: 'error', message: "fatal: bad revision 'nope'" }, '*');
    await settle(300);
    state('empty: git said why', '#empty');
    state('empty: the bar is off', '#progress');

    /*
     * Ticket ids in a commit message, marked from the patterns the host sends and opened by their text,
     * clicked or from the keyboard. Last, because it sends an init of its own.
     */
    window.postMessage(
      {
        type: 'init',
        repoName: 'weft-ui-probe-demo',
        repoRoot: '/demo',
        rowHeight: 24,
        authorColors: true,
        kind: null,
        ticketPatterns: ['ERP-[0-9]+'],
      },
      '*',
    );
    window.postMessage(
      {
        type: 'details',
        details: {
          sha: 'e'.repeat(40),
          parents: [],
          author: 'Weft Test',
          authorEmail: 'test@example.invalid',
          authorDate: '2026-01-01T00:00:00+00:00',
          committer: 'Weft Test',
          committerDate: '2026-01-01T00:00:00+00:00',
          body: 'Fix the total for ERP-10147\n\nAlso ERP-2, and not XERP-3.',
        },
      },
      '*',
    );
    await settle(250);
    take('ticket links', document.querySelector('#detail-body'));

    const beforeTicket = sent().length;
    const tickets = document.querySelectorAll('#detail-body .ticket');
    click(tickets[0]);

    if (tickets[1]) {
      tickets[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }

    await settle(200);
    parts.push('=== opening ticket ids sends ===\n' + sentSince(beforeTicket));

    /*
     * The merges-from switch: off it shows no box, on it shows an empty one and asks for nothing -
     * which matters, because asking for the empty filter is a walk of the whole history to arrive at
     * the graph already on screen. What it draws is asked for when a branch is typed into the box.
     * Last of the filters, because what it asks for is a walk and the demo history is replayed after it.
     */
    {
      const box = document.querySelector('#merges-from-branches');
      const names = () =>
        [...document.querySelectorAll('#merges-from-names .merges-from-name')].map((row) => row.textContent);
      const said = ['box hidden before: ' + document.querySelector('#merges-from-box').hidden];
      let before = sent().length;

      click(document.querySelector('#merges-from'));
      await settle(250);
      said.push('box hidden after: ' + document.querySelector('#merges-from-box').hidden);
      said.push('box holds: ' + JSON.stringify(box.value));
      said.push('switch: ' + JSON.stringify(document.querySelector('#merges-from').className));
      said.push('asked: ' + sentSince(before));

      before = sent().length;
      box.value = 'uat';
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(250);
      said.push('after editing: ' + sentSince(before));

      /*
       * Completing a name that is being typed, against a ref list posted in - the steps above leave a
       * stand-in list of their own, and a completion checked against whatever they happened to leave is
       * a completion checked against nothing in particular.
       *
       * A `t` matches `feat/columnar-store`; `uat` is a branch too and is already in the box; `main` has
       * no `t` in it; and `latest` is a tag, which is not a branch to filter merges from.
       */
      window.postMessage(
        {
          type: 'refs',
          branch: 'main',
          refs: [
            { label: 'main', refName: 'refs/heads/main', kind: 'local', visible: true, updated: 0 },
            { label: 'feat/columnar-store', refName: 'refs/heads/feat/columnar-store', kind: 'local', visible: true, updated: 0 },
            { label: 'origin/uat', refName: 'refs/remotes/origin/uat', kind: 'remote', visible: true, updated: 0 },
            { label: 'latest', refName: 'refs/tags/latest', kind: 'tag', visible: true, updated: 0 },
          ],
        },
        '*',
      );
      await settle(200);

      box.value = 'uat, t';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await settle(200);
      said.push('offered for "uat, t": ' + JSON.stringify(names()));

      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await settle(150);
      said.push('after an arrow: ' + JSON.stringify(names()));

      before = sent().length;
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle(250);
      said.push('completed to: ' + JSON.stringify(box.value));
      said.push('and asked: ' + sentSince(before));
      said.push('list after: hidden=' + document.querySelector('#merges-from-names').hidden);

      // An empty box offers nothing: four hundred branches over the graph is not an answer to anything.
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await settle(150);
      said.push('offered for nothing: ' + JSON.stringify(names()));

      box.value = 'uat, sit';
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(200);

      /*
       * The same branches again after the host has dropped every filter, and before the switch is
       * turned off - turning it off asks for nothing, which would leave the page ready to ask for these
       * again whether or not it had been told to forget. The page asks for the same thing twice for
       * nothing, each one being a walk; but "the same" holds only while the host is still drawing it,
       * and `filtersCleared` is the host saying it is not.
       */
      window.postMessage({ type: 'filtersCleared' }, '*');
      await settle(200);

      before = sent().length;
      click(document.querySelector('#merges-from'));
      await settle(250);
      said.push('after clearing: ' + sentSince(before));

      before = sent().length;
      click(document.querySelector('#merges-from'));
      await settle(250);
      said.push('off again: ' + sentSince(before));
      said.push('box kept: ' + JSON.stringify(box.value));

      parts.push('=== merges from ===\n' + said.join('\n'));
    }

    /*
     * And `weft.ticketLinks` corrected while the graph is open, which sends the patterns by themselves.
     * The commit is not sent again - the pane holds it - so what this shows is the pane marking what is
     * already on screen from patterns that arrived after it.
     */
    window.postMessage({ type: 'ticketPatterns', patterns: ['XERP-[0-9]+'] }, '*');
    await settle(250);
    take('ticket links after the setting changed', document.querySelector('#detail-body'));

    /*
     * The commit menu from the keyboard. Shift+F10 on the selected row asks for its menu, and the first
     * thing on it that can be chosen takes focus; the arrows go past what cannot be; Enter chooses;
     * Escape hands focus back. The contextmenu event a real Shift+F10 is followed by is swallowed, or
     * VS Code's own menu opens over this one. And the column menu is worked the same way.
     */
    {
      // The steps before this one leave the graph empty, and a menu from the keyboard is a selected row's:
      // the demo history is drawn again first, the way the page first drew it.
      if (typeof replay === 'function') {
        replay();
        await settle(800);
      }

      click(document.querySelector('#rows .row:not(.uncommitted)'));
      await settle(200);

      // From the graph, not from a box: a control with focus owns its keys, and an earlier step can
      // leave focus in one. Where it was is recorded, so a step that leaves it there can be found.
      const heldFocus = document.activeElement;
      const heldBy =
        heldFocus instanceof HTMLElement && heldFocus !== document.body
          ? heldFocus.tagName.toLowerCase() + (heldFocus.id ? '#' + heldFocus.id : '')
          : 'nothing';

      if (heldFocus instanceof HTMLElement && heldFocus !== document.body) {
        heldFocus.blur();
      }

      const key = (name, options) =>
        (document.activeElement || document.body).dispatchEvent(
          new KeyboardEvent('keydown', Object.assign({ key: name, bubbles: true, cancelable: true }, options || {})),
        );
      const inMenu = () => document.activeElement !== null && document.activeElement.closest('.menu') !== null;
      const focused = () => (inMenu() ? document.activeElement.textContent : '(outside the menu)');
      const closedState = () =>
        (document.querySelector('.menu') ? 'open' : 'closed') + (inMenu() ? ', focus inside' : ', focus outside');
      const said = ['focus was held by: ' + heldBy];

      const beforeKey = sent().length;
      key('F10', { shiftKey: true });
      await settle(100);

      const asked = sent().slice(beforeKey).find((m) => m.type === 'requestMenu');
      const echo = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(echo);

      // Answered by the page's stand-in for the host, as every request is: the real items, and one of them
      // greyed out.
      await settle(250);

      said.push('asked: ' + (asked ? JSON.stringify(asked.target.kind) : 'nothing'));
      said.push('echo swallowed: ' + echo.defaultPrevented);
      said.push(
        'choosable: ' + JSON.stringify([...document.querySelectorAll('.menu .menu-item:not(.disabled)')].map((el) => el.textContent)),
      );
      said.push('opened on: ' + focused());
      key('End');
      said.push('end: ' + focused());
      key('Home');
      said.push('home: ' + focused());

      // To the item just before the greyed-out one, then down past it, and back up - where Enter chooses.
      const items = [...document.querySelectorAll('.menu .menu-item')];
      const greyed = items.findIndex((el) => el.classList.contains('disabled'));
      const around = [
        greyed > 0 ? items[greyed - 1].textContent : '',
        greyed >= 0 && items[greyed + 1] ? items[greyed + 1].textContent : '',
      ];
      said.push('around the greyed-out one: ' + JSON.stringify(around));

      for (let i = 0; i < 12 && focused() !== around[0]; i += 1) {
        key('ArrowDown');
      }

      key('ArrowDown');
      said.push('past the greyed-out one: ' + focused());
      key('ArrowUp');
      said.push('and back: ' + focused());

      const beforeChoose = sent().length;
      key('Enter');
      await settle(150);
      said.push('chose: ' + sentSince(beforeChoose));
      said.push('after choosing: ' + closedState());

      key('F10', { shiftKey: true });
      await settle(350);
      key('Escape');
      await settle(100);
      said.push('after escape: ' + closedState());

      if (columns) {
        columns.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 10 }));
      }

      await settle(200);
      key('ArrowDown');
      said.push('column menu: ' + focused());
      key('Escape');
      await settle(100);
      said.push('column menu after escape: ' + closedState());

      parts.push('=== the commit menu from the keyboard ===\n' + said.join('\n'));
    }
  } catch (error) {
    // Written rather than lost: a probe that dies partway leaves a recording that looks deliberate.
    parts.push('=== probe failed ===\n' + String((error && error.stack) || error));
  }

  const thrown = window.__thrown || [];
  parts.push('=== thrown ===\n' + (thrown.length === 0 ? '(nothing)' : thrown.join('\n')));

  const out = document.createElement('pre');
  out.id = 'ui-probe';
  out.textContent = parts.join('\n\n');
  document.body.appendChild(out);
})();
