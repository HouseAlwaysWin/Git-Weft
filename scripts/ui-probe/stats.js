/*
 * The UI probe's script for the statistics tab: replays what the host sends the tab, and records what the
 * page draws and what it sends back.
 *
 * Injected by scripts/ui-probe.mjs, after stats.js, into a copy of dist/stats-preview.html - which carries
 * summaries made by the real tally and summary, one from the demo repository's walk and the rest from
 * commits a seeded generator made up, with the commits, merges and excluded commits behind each counted
 * without them.
 * Sections are headed `=== stats: name ===`, so they sit beside the graph's in one recording.
 *
 * It writes facts down and judges nothing. What has to hold is in the runner, where a mistake in this
 * script cannot pass a check by leaving it out.
 */
(async () => {
  const parts = [];
  const section = (name, lines) => parts.push('=== stats: ' + name + ' ===\n' + [].concat(lines).join('\n'));

  try {
    const settle = (ms) => new Promise((done) => setTimeout(done, ms));
    const post = (message) => window.postMessage(message, '*');
    const one = (selector) => document.querySelector(selector);
    const all = (selector) => [...document.querySelectorAll(selector)];
    const says = (selector) => ((one(selector) || {}).textContent || '').trim();
    const sent = () => window.__sent || [];
    const summaries = window.__stats || {};
    const hueOf = (el) => (el && el.style.getPropertyValue('--weft-author-hue')) || '-';
    const charts = () => 'hidden=' + one('#stats-charts').hidden + ' class=' + JSON.stringify(one('#stats-charts').className);

    /** Everything one drawn summary puts on the page, as lines. */
    const drawn = () => {
      const lines = [
        'title: ' + says('#stats-title'),
        'scope: ' + says('#stats-scope'),
        'switch: checked=' + one('#stats-merges').checked,
        'excluded switch: hidden=' + one('#stats-excluded-switch').hidden + ' checked=' + one('#stats-excluded').checked,
        'notes: ' + all('#stats-notes li').map((note) => note.textContent).join(' | '),
        'state: hidden=' + one('#stats-state').hidden + ' message=' + JSON.stringify(says('#stats-message')),
        'charts: ' + charts(),
        'time: hidden=' + one('#stats-time').hidden,
        'total heading: ' + says('#stats-total-heading'),
        'stacked heading: ' + says('#stats-stacked-heading'),
        'show all: hidden=' + one('#stats-show-all').hidden + ' text=' + JSON.stringify(says('#stats-show-all')),
      ];

      for (const row of all('#stats-people .stats-person')) {
        const name = row.querySelector('.stats-name');
        const bar = row.querySelector('.stats-bar');

        lines.push(
          'person: ' +
            [
              name.textContent,
              row.querySelector('.stats-count').textContent,
              row.querySelector('.stats-merged').textContent,
              bar.className,
              'share=' + bar.style.getPropertyValue('--weft-stats-share'),
              'hue=' + hueOf(bar),
              'children=' + name.children.length,
              'excluded=' + ((row.querySelector('.stats-excluded-count') || {}).textContent || ''),
            ].join(' | '),
        );
      }

      for (const item of all('#stats-legend li')) {
        lines.push('legend: ' + item.textContent + ' | hue=' + hueOf(item.querySelector('.stats-swatch')));
      }

      /*
       * The stacked chart, bar by bar: the count the chart of every commit gives that bar, then the counts,
       * heights and names of the pieces stacked on it, bottom first. Both charts are one width, so a bar is
       * at the same x in each. The scale is read off the lines across, so the height the pieces have to
       * make is worked out from what was drawn rather than from the page's own numbers.
       */
      const across = all('#stats-stacked .stats-grid').map((line) => Number(line.getAttribute('y1')));
      const scale = all('#stats-stacked .stats-axis[text-anchor="end"]').map((text) => Number(text.textContent.replace(/,/g, '')));

      lines.push(
        'stacked scale: top=' + Math.max(0, ...scale) + ' plot=' + (across.length > 1 ? Math.max(...across) - Math.min(...across) : 0),
      );

      const countOf = (rect) => {
        const said = /: ([\d,]+) commits?$/.exec(rect.querySelector('title').textContent);
        return said === null ? '?' : said[1].replace(/,/g, '');
      };

      const totals = new Map(all('#stats-total rect').map((rect) => [rect.getAttribute('x'), countOf(rect)]));
      const bars = new Map();

      for (const rect of all('#stats-stacked rect')) {
        const title = rect.querySelector('title').textContent;
        const x = rect.getAttribute('x');

        bars.set(x, [
          ...(bars.get(x) || []),
          { count: countOf(rect), height: rect.getAttribute('height'), who: title.slice(0, title.indexOf(', ')) + '@' + hueOf(rect) },
        ]);
      }

      for (const [x, pieces] of bars) {
        lines.push(
          'bar ' + x + ': total=' + (totals.get(x) || '?') +
            ' counts=' + pieces.map((piece) => piece.count).join('+') +
            ' pieces=' + pieces.map((piece) => piece.height).join('+') +
            ' who=' + pieces.map((piece) => piece.who).join(','),
        );
      }

      return lines;
    };

    // The stand-in host answers the page's ready with the demo repository's walk.
    await settle(800);
    section('walk', drawn());

    /*
     * Three years: more people than the list shows at first, so everyone is asked for before the rows are
     * written down. The last of them only merges, and with merges left out has no commits to rank above
     * anybody, so the fiftieth row is well above theirs.
     */
    post({ type: 'summary', summary: summaries.long });
    await settle(400);

    const listedBefore = all('#stats-people .stats-person').length;
    one('#stats-show-all').click();
    await settle(200);

    section('show all', [
      'listed before: ' + listedBefore,
      'listed after: ' + all('#stats-people .stats-person').length,
      'people: ' + ((summaries.long || {}).people || []).length,
      'button: hidden=' + one('#stats-show-all').hidden,
    ]);
    section('long', drawn());

    for (const name of ['fortyDays', 'one', 'stopped', 'released']) {
      post({ type: 'summary', summary: summaries[name] });
      await settle(400);
      section(name, drawn());
    }

    section(
      'expected',
      Object.entries(window.__expected || {}).map(
        ([name, counts]) => name + ': commits=' + counts.commits + ' merges=' + counts.merges + ' excluded=' + (counts.excluded || 0),
      ),
    );

    // Merges counted in: the page asks, remembers it asked, and says so once the host answers.
    post({ type: 'summary', summary: summaries.long });
    await settle(400);

    const mergesBox = one('#stats-merges');
    const beforeSwitch = sent().length;
    mergesBox.checked = true;
    mergesBox.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(150);

    const asked = sent().slice(beforeSwitch).map((message) => JSON.stringify(message)).join(' ');
    post({ type: 'summary', summary: summaries.longWithMerges });
    await settle(400);

    section('merges switched on', [
      'sends: ' + asked,
      'remembered: ' + JSON.stringify(window.__state === undefined ? null : window.__state),
      'scope: ' + says('#stats-scope'),
    ]);

    mergesBox.checked = false;
    mergesBox.dispatchEvent(new Event('change', { bubbles: true }));
    post({ type: 'summary', summary: summaries.long });
    await settle(400);

    // Excluded commits put back: the same asking, remembering and saying, for the rule's own switch.
    post({ type: 'summary', summary: summaries.released });
    await settle(400);

    const excludedBox = one('#stats-excluded');
    const beforeExcluded = sent().length;
    excludedBox.checked = true;
    excludedBox.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(150);

    const askedExcluded = sent().slice(beforeExcluded).map((message) => JSON.stringify(message)).join(' ');
    post({ type: 'summary', summary: summaries.releasedWithExcluded });
    await settle(400);

    section('excluded switched on', [
      'sends: ' + askedExcluded,
      'remembered: ' + JSON.stringify(window.__state === undefined ? null : window.__state),
      'scope: ' + says('#stats-scope'),
    ]);

    excludedBox.checked = false;
    excludedBox.dispatchEvent(new Event('change', { bubbles: true }));
    post({ type: 'summary', summary: summaries.long });
    await settle(400);

    section('a name that is markup', [
      'bold elements: ' + document.querySelectorAll('b').length,
      'rows naming it: ' +
        all('#stats-people .stats-name').filter((el) => el.textContent === '<b>not bold</b>' && el.children.length === 0).length,
    ]);

    // A walk begins with charts on screen: they stay, and dim once it has taken a while.
    post({ type: 'walking' });
    await settle(400);
    section('while the next walk is counted', ['charts: ' + charts()]);

    post({ type: 'summary', summary: summaries.long });
    await settle(300);
    section('when it has been', ['charts: ' + charts()]);

    // The graph closed, and the button that opens one.
    post({ type: 'noGraph' });
    await settle(200);
    section('no graph', [
      'message: ' + says('#stats-message'),
      'button: hidden=' + one('#stats-open-graph').hidden + ' text=' + JSON.stringify(says('#stats-open-graph')),
      'charts: ' + charts(),
    ]);

    const beforeOpen = sent().length;
    one('#stats-open-graph').click();
    await settle(200);
    section('opening the graph sends', sent().slice(beforeOpen).map((message) => JSON.stringify(message)));

    // A walk with no charts from before it to keep.
    post({ type: 'walking' });
    await settle(400);
    section('a first walk', [
      'message: ' + says('#stats-message'),
      'button: hidden=' + one('#stats-open-graph').hidden,
      'charts: ' + charts(),
    ]);

    post({ type: 'failed', message: "fatal: bad revision 'nope'" });
    await settle(200);
    section('failed', ['message: ' + says('#stats-message'), 'charts: hidden=' + one('#stats-charts').hidden]);

    post({ type: 'summary', summary: summaries.nothing });
    await settle(200);
    section('nothing', ['message: ' + says('#stats-message'), 'charts: hidden=' + one('#stats-charts').hidden]);
  } catch (error) {
    // Written rather than lost: a probe that dies partway leaves a recording that looks deliberate.
    parts.push('=== stats: probe failed ===\n' + String((error && error.stack) || error));
  }

  const thrown = window.__thrown || [];
  parts.push('=== stats: thrown ===\n' + (thrown.length === 0 ? '(nothing)' : thrown.join('\n')));

  const out = document.createElement('pre');
  out.id = 'ui-probe';
  out.textContent = parts.join('\n\n');
  document.body.appendChild(out);
})();
