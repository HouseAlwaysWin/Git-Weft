/**
 * The webview's body markup, in one place.
 *
 * Both the real panel and the offline preview harness render this, so the thing being previewed
 * cannot quietly drift away from the thing that ships.
 *
 * The nesting matters: the canvas is a sibling of the scroller, not a child of it. Inside the
 * scroller it would need to be as tall as the whole history - which no browser will allocate at
 * 100k rows - so instead one viewport-sized canvas is overlaid and redrawn per frame with the
 * scroll offset folded into the Y coordinate.
 *
 * The column header is a sibling of the scroller too, for the same reason in reverse: it must not
 * move when the rows do. It carries the same grid template as a row, so a label sits over its own
 * column without either side knowing the other's widths.
 *
 * The search switches sit inside the input rather than beside it - the way VS Code's own find box
 * does - so that a box wide enough to type in stays wide enough to type in.
 *
 * The custom date range sits beside the dropdown that summons it, which is the only place it reads
 * as belonging to it. Two date pickers are a lot of bar, so each row wraps rather than squeezing the
 * query box: on a narrow panel the search switches fold instead of shrinking.
 */
/*
 * Two rows, explicitly, rather than one row left to wrap.
 *
 * The repository's name and the controls share the top row - the name at one end, everything that
 * changes what is on screen at the other, which is the shape of a title bar and reads as one. That
 * includes the two buttons that undo a choice rather than make one: they are only ever there
 * because something above them is set. The row underneath is left saying where the repository
 * stands and nothing else - the branch, how it sits against its remote, how old that answer is,
 * how big the walk was.
 *
 * It used to be one line that wrapped when it ran out of room, which was fine until the branch menu
 * arrived: on a branch called `claude/changelog-v0.52.0` the name was on the line twice - once as
 * the button and once inside the upstream summary - and the row it wrapped into was whichever the
 * widths happened to produce. Splitting it means the second line is a place rather than an
 * accident.
 */
export const BODY_MARKUP = `<header id="header">
  <div id="header-controls">
    <span id="title">Weft</span>
    <button id="clear-sort" type="button" hidden
      title="A sorted list is flat: the lanes only mean anything in the order git walked them. Click to go back.">graph order</button>
    <button id="clear-filters" type="button" hidden
      title="Drop the search, the date range, and the branch and author filters in Source Control. The sort is left alone.">clear filters</button>
    <span id="search-box">
      <button class="toggle" id="first-parent" type="button"
        title="Walk only the first parent of every merge: the mainline, without the commits that were merged into it.">first parent</button>
      <button class="toggle" id="only-here" type="button"
        title="Only what the ticked branches have and no other ref does. Ticking one branch narrows where git starts, not what it reaches - a branch cut off a trunk with three hundred others merged into it still reaches all of them. This is the other question: what is on this branch and nowhere else. With every branch ticked there is nothing left to exclude, so it does nothing.">only here</button>
      <button class="toggle" id="merges-from" type="button"
        title="Draw only what came into this history from these branches, however it came: the merges that took one of them into somebody&#39;s feature branch, and the commits taken across one at a time, which are found by their change rather than by anything written down. A squash leaves neither behind. Stacks with everything else here: a person and a month and this switch answer one question between them.">came from</button>
      <span id="merges-from-box" hidden>
        <input id="merges-from-branches" type="text" spellcheck="false" autocomplete="off"
          placeholder="uat, sit" aria-label="Branches whose merges to draw"
          aria-autocomplete="list" aria-controls="merges-from-names"
          title="Which branches, separated by commas. Typing offers the branches this repository has; a name matches whole, with any remote in front of it, so uat is also origin/uat and is not uat_deploy.">
        <div id="merges-from-names" hidden></div>
        <span id="merges-from-window" hidden
          title="What this switch is comparing. Copies are found between two sides, so the only commits it can find are the ones this graph has and that branch does not - a handful for a branch that is merged back every day, thousands for one left alone for months. Merges are not bounded this way: they are read from the message, anywhere in the history drawn."></span>
      </span>
      <select id="commit-order" title="How git orders the walk. All three keep a parent below its children, which the lanes depend on, and all three cost the same - the difference is which shape the history reads best in. Topological keeps a branch&#39;s commits together instead of interleaving them by date.">
        <option value="date">commit date</option>
        <option value="author-date">author date</option>
        <option value="topo">topological</option>
      </select>
      <select id="date-range" title="Limit the walk to a stretch of time. git compares the committer date, which the Date column does not show - identical for ordinary history, different for anything rebased.">
        <option value="">any time</option>
        <option value="today">today</option>
        <option value="7">last 7 days</option>
        <option value="30">last 30 days</option>
        <option value="365">last 12 months</option>
        <option value="custom">custom&hellip;</option>
      </select>
      <span id="date-custom" hidden>
        <input id="date-since" type="date" title="From this day. Leave empty for no lower bound.">
        <span class="date-arrow">&rarr;</span>
        <input id="date-until" type="date" title="Up to and including this day. Leave empty for no upper bound.">
        <button id="date-close" type="button" title="No date filter" aria-label="Clear the date range">&#10005;</button>
      </span>
      <select id="search-mode">
        <option value="message" title="The commit message. What most searches mean.">message</option>
        <option value="author" title="Who wrote the commit. Matches the name or the email address, so a domain finds everyone at one company.">author</option>
        <option value="committer" title="Who committed it, which is the same person as the author until a commit is rebased, cherry-picked, or applied from a patch by somebody else. On a repository where one person lands everyone else&#39;s work, this is how you find what they landed.">committer</option>
        <option value="content" title="Not the message - the files. Finds commits whose diff added or removed this text, which is how you ask when a function first appeared or when a string was deleted. No other mode can answer that.">content</option>
        <option value="path" title="Commits that touched this path. The follow switch carries the history past a rename - and past a copy, so read what it says before trusting it.">path</option>
      </select>
      <span id="search-field">
        <input id="search-input" type="search" placeholder="Search or paste a hash" spellcheck="false">
        <span id="search-toggles">
          <button class="toggle" type="button" data-toggle="caseSensitive" title="Match case">Aa</button>
          <button class="toggle" type="button" data-toggle="regex" title="Read the query as a regular expression">.*</button>
          <button class="toggle" type="button" data-toggle="allTerms" title="Require every word, not any one of them">all</button>
          <button class="toggle" type="button" data-toggle="invert" title="Show the commits that do not match">not</button>
          <button class="toggle" type="button" data-toggle="follow" title="Carry the history past a rename, so it does not stop where the file was moved. Off by default, because git looks for copies as well: a file scaffolded by copying its neighbour is followed into the neighbour's history, and nothing says so. git will not take a case-insensitive path this way either, so matching becomes exact.">follow</button>
        </span>
      </span>
    </span>
  </div>
  <div id="header-status">
    <span id="branch-menu">
      <button id="branch-button" type="button" aria-haspopup="true" aria-expanded="false"
        title="Choose which branches the graph draws. The ticks are the same ones as in Branches &amp; Tags. To switch branch, use the box beside this one.">
        <span id="branch-current">no branch</span>
        <span class="chevron" aria-hidden="true">&#9662;</span>
      </button>
      <div id="branch-list" hidden>
        <input id="branch-filter" type="search" placeholder="Filter branches" spellcheck="false"
          aria-label="Filter the branch list">
        <div id="branch-presets" aria-label="Presets"></div>
        <div id="branch-rows"></div>
        <div id="branch-empty" hidden>No branch matches.</div>
      </div>
    </span>
    <span id="branch-jump-box">
      <input id="branch-jump" type="search" placeholder="Switch branch…" spellcheck="false"
        aria-label="Type a branch name to switch to it" aria-autocomplete="list"
        aria-controls="jump-rows"
        title="Type a branch name, arrows to aim, Return to check it out.">
      <div id="jump-list" hidden>
        <div id="jump-rows"></div>
        <div id="jump-empty" hidden>No branch matches.</div>
      </div>
    </span>
    <span id="ref-presets">
      <button class="ref-preset" data-preset="all" type="button"
        aria-label="Draw every branch and tag"
        title="Draw every branch and tag. The same button as in Branches &amp; Tags.">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><path
          d="M5.5 8.1 7.2 9.9 10.6 6.2"/></svg>
      </button>
      <button class="ref-preset" data-preset="current" type="button"
        aria-label="Draw only the branch you are on"
        title="Draw only the branch you are on, and follow it across a checkout.">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><circle
          class="filled" cx="8" cy="8" r="1.7"/></svg>
      </button>
      <button class="ref-preset" data-preset="none" type="button"
        aria-label="Draw nothing"
        title="Draw nothing, so ticking the two you want is two clicks rather than fourteen hundred.">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><path
          d="M4.3 11.7 11.7 4.3"/></svg>
      </button>
    </span>
    <span id="upstream" hidden></span>
    <span id="status">loading&hellip;</span>
    <button id="compare-mark" type="button" hidden></button>
  </div>
</header>
<section id="operation" hidden></section>
<div id="columns">
  <button class="col" type="button" data-sort="subject">Description<span class="sort-arrow"></span></button>
  <button class="col" type="button" data-sort="author">Author<span class="sort-arrow"></span></button>
  <button class="col" type="button" data-sort="date">Date<span class="sort-arrow"></span></button>
  <button class="col" type="button" data-sort="sha">Commit<span class="sort-arrow"></span></button>
  <span class="col-grip" data-grip="graph" title="Drag to give the lanes more or less room. Double-click to let them take what they need, up to a third of the panel."></span>
  <span class="col-grip" data-grip="author" title="Drag to resize Author. Double-click to reset it."></span>
  <span class="col-grip" data-grip="date" title="Drag to resize Date. Double-click to reset it."></span>
  <span class="col-grip" data-grip="sha" title="Drag to resize Commit. Double-click to reset it."></span>
</div>
<main id="main">
  <div id="viewport"><div id="spacer"></div><div id="rows"></div></div>
  <canvas id="graph"></canvas>
  <div id="progress" hidden role="progressbar" aria-label="Walking the history"></div>
  <p id="empty" hidden></p>
</main>
<div id="splitter" hidden role="separator" aria-orientation="horizontal" title="Drag to resize"></div>
<section id="details" hidden>
  <button id="detail-close" type="button" title="Close (Esc)" aria-label="Close details">✕</button>
  <div id="detail-meta"></div>
  <pre id="detail-body"></pre>
  <div id="detail-commits" hidden></div>
</section>`;

/**
 * The statistics tab's body: a page of its own that shares only the stylesheet, where every rule for it
 * sits under `body.weft-stats`.
 */
export const STATS_MARKUP = `<header id="stats-header">
  <h1 id="stats-title">Statistics</h1>
  <p id="stats-scope"></p>
  <label id="stats-merges-switch" title="A merge request leaves two commits: the work, and a merge credited to whoever pressed the button. Left out, the charts count the work.">
    <input id="stats-merges" type="checkbox"> Include merges
  </label>
  <label id="stats-excluded-switch" hidden title="Commits whose subject matches weft.statistics.excludeMessages. Left out, the charts count everything else.">
    <input id="stats-excluded" type="checkbox"> Include excluded commits
  </label>
  <ul id="stats-notes"></ul>
</header>
<section id="stats-state">
  <p id="stats-message">Counting as the graph walks&hellip;</p>
  <button id="stats-open-graph" type="button" hidden>Open the Graph</button>
</section>
<main id="stats-charts" hidden>
  <section class="stats-chart" aria-labelledby="stats-people-heading">
    <h2 id="stats-people-heading">Commits per person</h2>
    <ol id="stats-people"></ol>
    <button id="stats-show-all" type="button" hidden></button>
  </section>
  <section id="stats-time" class="stats-chart" hidden>
    <h2 id="stats-total-heading">Commits over time</h2>
    <svg id="stats-total" class="stats-time" role="img"></svg>
    <h2 id="stats-stacked-heading">Each person over time</h2>
    <label id="stats-side-by-side-switch" title="One bar each from the same baseline, rather than stacked into the bar's total. Easier to compare a few people; the stack says what a week or a month came to.">
      <input id="stats-side-by-side" type="checkbox"> Side by side
    </label>
    <svg id="stats-stacked" class="stats-time" role="img"></svg>
    <ul id="stats-legend" class="stats-legend"></ul>
  </section>
</main>`;

/**
 * The interactive rebase editor's body: the commits the rebase will replay, in the order it will replay
 * them, and what it will do with each. Every rule for it sits under `body.weft-rebase`.
 */
export const REBASE_MARKUP = `<header id="rebase-header">
  <h1 id="rebase-title">Interactive rebase</h1>
  <p id="rebase-onto"></p>
</header>
<ol id="rebase-rows"></ol>
<footer id="rebase-footer">
  <p id="rebase-problem" hidden></p>
  <p id="rebase-summary"></p>
  <p id="rebase-help">Alt and the arrow keys move a commit. Closing this editor starts the rebase.</p>
  <div id="rebase-buttons">
    <button id="rebase-start" type="button">Start Rebase</button>
    <button id="rebase-abort" type="button">Abort</button>
  </div>
</footer>`;
