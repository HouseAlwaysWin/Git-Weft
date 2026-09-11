# Changelog

## Unreleased

- **Checking out asks first from Branches & Tags too, and when it detaches onto a commit.** 0.8.0
  said checking out asks first wherever it was asked for, and two ways in did not: Checkout on a
  branch in Branches & Tags went straight through, and so did Checkout on a commit in the graph. The
  question was asked where the graph's messages arrive, and the sidebar does not send messages - it
  calls the action directly - while a commit was waved through as something picked by pointing. It
  is asked now where every checkout passes, whoever started it, and one that detaches HEAD says so,
  since new commits made there belong to no branch until one is made for them. It also comes after
  the check that refuses, so checking out the branch you are already on says so, instead of first
  asking whether you are sure.

- **Backing out of an action's own question no longer reloads the graph.** Dismissing the name box
  for a new branch was read as the action having run: the whole history was walked again to draw
  what was already there, and the status bar said `Weft:` with nothing after it but `(was …)`.

## 0.8.0

- **The branch dropdown filters the graph. It no longer checks anything out.** Every row held two
  different things a pixel apart: a tick that decides whether the graph draws that ref, and beside
  it the branch name as a button that switched branch. The destructive one had the bigger target,
  and it was the one that did not ask - the quick-switch box next to it puts up "Check out uat? Last
  moved 3h ago." first, and clicking a name in the list did not. A checkout rewrites the worktree,
  which on a large repository is a lot of files changing under whatever else is open - and it was
  one stray click away.

  The whole row is the tick now. Switching branch is the box beside it, which asks.

- **Checking out asks first, wherever it was asked for.** Whether a checkout was confirmed depended
  on which control you reached for: the quick-switch box asked, Checkout on a ref's right-click menu
  did not. Two answers for one action. It is the action's own answer now rather than each caller's,
  so there is no longer a path that can forget. Two of the three that existed had.

- **What the graph is drawing has a section of its own, at the top.** On a repository with a hundred
  and fifty branches, ticking one was the last you saw of it: the list is alphabetical, and what you
  had just switched on was somewhere in the middle of it. The drawn refs are lifted into their own
  section above the rest, local and remote together, each saying which it is - because
  `origin/release/v1.3` and `release/v1.3` are two different things to be drawing, and split by
  kind a ticked remote sits below every local branch there is.

  The list also follows the sort the sidebar is set to, which it never did: switching Branches &
  Tags to "most recent" left the dropdown in git's own refname order, so the same refs read
  differently in the two places.

- **The search highlight follows the mode.** Type a word, switch the search from message to author,
  and the marks stayed on the subject - the column the search was no longer looking at - until
  something else forced a repaint. The pattern for `lane` is identical in both modes, and the
  repaint was decided on the pattern alone.

- **Switching to another tab and back no longer re-walks the history.** VS Code tears a webview
  down when its tab is hidden, and the graph's first act on the way back was to ask for the whole
  history again - so returning to a graph you were already looking at cost a full reload, with the
  scroll position, the selection and the details pane thrown away with it. The setting that caused
  it was justified in a comment saying the graph "reloads in under a second, so it is not worth the
  RAM"; measured on a 78,282-commit repository it was 2.3 seconds, and the RAM is 55.9 MB.

  Keeping it alive means a hidden tab keeps hearing about the working tree, so the other half of
  this had to come with it: re-deriving the view was re-sorting the entire history, 305 ms for
  Description on 78,000 rows, on every file saved. It is remembered now - the same question asked a
  hundred times more costs three ten-thousandths of a millisecond - and the remembering lives in
  `sort.ts` where it can be tested without a browser, which is how the four ways of asking a
  different question are pinned down.

- **The graph stops spending four times longer getting ready than working.** Measured on a
  78,282-commit repository with 1,177 refs and 38,696 tracked files: 1,875 ms of preamble before
  `git log` was invoked at all, against 462 ms to walk the entire history.

  Two things were in the way, and neither needed to be. Reading the repository's state - which feeds
  one thing, the banner saying git is mid-rebase - was awaited, and on a worktree that size its
  `git status` alone is 809 ms. The comment there said the reader should be told "while the walk is
  still running, not once it finishes"; awaiting it did the opposite. It is fired now and posts when
  it lands, which is what that sentence describes.

  And the stash probes, which decide whether a stash hangs off anything being drawn, were asked one
  after another. They are independent questions, and on Windows spawning git costs more than
  answering: 649 ms for three. Asked together they are 272 ms. One command for all of them would be
  better still and there is no correct one - `rev-list --no-walk` is documented to stop meaning
  anything once a range is given, and measured, it walked 63,130 commits and answered the wrong
  question.

  The preamble is about 690 ms now. It is also cancellable at last: none of it took the abort
  signal, so a superseded reload - ticking a second branch while the first is still loading - ran
  every bit of it to completion before noticing.

- **The button that opens the graph says something while it works.** Between clicking it in Source
  Control and the tab appearing there is a repository to find and a ref list to read, and none of
  it had anywhere to show: the graph's own progress bar is inside the webview, and the webview is
  what is being waited for. A spinner in the status bar covers the gap now, naming what it is doing.

  It is also a shorter gap. Discovery ran once per candidate folder, one after another - and the
  candidates are usually the same repository arrived at three ways, since the built-in git extension
  knows it, it is the workspace folder, and the open file is inside it. Measured on a
  78,000-commit repository: 500ms for three, 236ms when they go at once, for the same answer in the
  same order.

- **A graph that is still loading says so.** Opening a large repository showed an empty pane and a
  word in a 0.9em grey at the far right of the header - which is where you look for it once you
  already know it is there. There is a progress bar across the top of the rows now, the one VS Code
  puts in that exact place for that exact reason, and a sentence in the middle of the empty pane
  saying what is being waited for.

  Both wait a quarter of a second first. Most reloads finish in tens of milliseconds - a tick
  moved, a file saved - and something that appears and vanishes inside one blink reads as a glitch
  rather than as progress. A walk that is going to take four seconds has still said so almost at
  once.

  The empty pane now also tells three states apart that used to look identical: still walking,
  narrowed to nothing by a filter, and a repository with no commits in it. A fourth, too - a walk
  that failed puts git's own words in the middle of the pane, which used to claim the repository
  had no commits while the header said otherwise.

## 0.7.0

- **Show Line History**, on the editor's right-click menu: the commits that touched the lines you
  have selected, or the line the cursor is on. The question blame raises and does not answer -
  blame says who touched a line last, this says who touched it before that, and what they were
  doing at the time.

  Not the file's history narrowed down. git re-derives the range at every step, so a commit that
  changed a different part of the same file is not in the answer, a line that moved within the file
  is followed to where it moved, and a rename is crossed by the lines themselves rather than by a
  similarity score - which is the trap `--follow` fell into.

  It gets a section of its own in Source Control rather than taking the graph over, and that is
  forced rather than preferred: `git log -L` digs from exactly one commit, and says so twice -
  two refs are *More than one commit to dig from*, and the shape the graph uses to exclude refs is
  *No commit specified?*. Answering in the graph would have meant standing the branch ticks down
  every time somebody asked about three lines. So it answers from HEAD, says so in its heading, and
  clicking a row finds that commit in the graph - the same jump the blame hover makes.

- **Merge arcs are drawn.** A merge whose second parent already had a lane on screen was joined
  to it by nothing at all: the layout had been working the curve out and handing it over on
  every page, and the view had never once mentioned it. On a history that merges a long-lived
  branch back repeatedly - which is most of them - that is most of the merge joins missing,
  and a graph missing them still looks like a graph, which is why it went unnoticed.

- **The two author filters narrow each other instead of widening.** The Authors ticks and the
  search box's author mode both say `--author`, and git reads several of those as "any of these" -
  so ticking one person and typing another handed back both, which is more rows than either filter
  gave on its own. There is no way to intersect two `--author` patterns in git, so the query is
  now spent picking out the ticked people it also matches. Which means the query has to be
  understood here, in git's dialect: `Ada\|Grace` is an alternation and `Ada|Grace` is a literal
  pipe, and JavaScript has both exactly the other way round. Measured against git across two dozen
  queries, on the one invariant worth having - ticking everybody must not change what a search
  finds.

  And an intersection that comes out empty now says so. An empty list of `--author` arguments does
  not mean "nobody" to git, it means "no author filter", so searching a ticked person's list for a
  name they have never spelled would have opened the whole history instead of closing it.

- **A search no longer quietly folds the case of the authors you ticked.** `--regexp-ignore-case`
  is walk-wide: it reaches every pattern on the command line, the Authors sidebar's spellings
  included. So typing anything at all into the box - the case switch is off by default - put
  `sean_lin` back in a graph where only `SEAN_LIN` had been ticked, which is the whole point of
  being able to tick them apart. Case for a pattern we wrote is now carried inside it, and the
  walk-wide flag is left for the one case with no alternative: a regular expression the reader
  wrote, which is not ours to rewrite.

- **All words is gone from author and committer mode**, where it never worked. `--all-match`
  governs `--grep` and nothing else: measured, `--all-match --committer=Ali --committer=zz` still
  returns Ali's commits though nobody in that repository is called `zz`. The button widened the
  search while its label said it narrowed it, which is worse than not being there.

- **The uncommitted row keeps up with the working tree again** where the repository's folder has
  more than one name. Saving a file moves nothing inside `.git`, which is all Weft watches itself,
  so it hears about it from the built-in git extension instead - and it found the right repository
  to listen to by comparing two paths as text. One directory has several spellings:
  `C:\Users\MARTIN~1\...` and `C:\Users\Martin_Wang\...` are the same folder, and a junction or a
  symlink parts them just as well. Both sides are resolved before they are compared now.

  Nothing about this looked like a bug, which is why it stood for four days with a test pointing
  straight at it: the subscription simply never happened, and a stale row says nothing. It is also
  the last red in `npm test`, which now passes end to end.

- **A frame of the graph is drawn about five times faster**, which is the first time anyone has
  measured it. On a repository of 78,000 commits and 1,177 refs a frame took 3.9ms at the median,
  10.2ms at the ninetieth and 33ms at its worst - at 60fps, two frames dropped in the middle of a
  scroll. It is now 0.7ms, 1.5ms and 2.7ms.

  Two causes, both the same mistake in different clothes: asking a question after making it
  expensive to answer.

  Reading the panel's size off the DOM is free while nothing has been written since the last
  layout, and costs a whole re-layout the moment something has. `render` set the header's padding
  and then asked for a width; drawing the lanes asked for the viewport's height and scroll position
  after every row in it had just been replaced. Measured at 0.9ms for one such read, twice a frame.
  Everything is read once now, at the top, before anything is written.

  And a frame tested every lane the layout had ever opened - 19,886 of them, to find the sixty on
  screen. Lanes open as the walk goes down, so held in that order the first one that opens below
  the fold rules out every lane after it. The old walk is kept as a test rather than as code: it
  and the search have to name the same lanes in the same order, for every viewport the history has,
  because a graph quietly missing lanes still looks like a graph.

- **An author can be in more than one group.** A group was a box, so putting somebody on the
  platform team took them off the release rota - which is not a question anybody should have been
  asked. It is a label now: **Add to Group…** adds one without removing the others, a spelling is
  listed under every group it is in and says on its row where else it appears, and **Remove from
  This Group** takes it out of the one that was right-clicked rather than out of all of them.

  Two things follow, and both are the answer rather than the price of it. The counts across rows
  can add up to more than the history has, because two groups sharing a person each count that
  person's commits - and each would walk them, so a row saying anything else would be a number no
  tick of it could produce. And a spelling put somewhere by hand is listed there and nowhere else:
  an assignment replaces what the spelling rule would have done with it rather than adding to it,
  or the first person you grouped would appear twice.

  One exception, which is the flow that made it necessary. Joining `Lineric` and `lineric_lin`
  under the name `Lineric` writes only one of them down - the other is in that group because the
  group was named after it. Adding a label to the pair now writes the unnamed one down as being in
  both, rather than moving it out of the group its own name had just made.

  Groups saved by 0.6.0 are read as they were written; nobody loses the grouping they have already
  done.

- **Show File History shows that file's history**, and not the history of whatever it was copied
  from. It was asking git to follow renames, and `--follow` is not only about renames: git turns
  copy detection on for it, looking for a source among every file in the commit that added the
  path rather than only among the ones that went away. A file scaffolded by copying its neighbour
  is therefore followed onto the neighbour - which is still sitting there beside it.

  Measured on `wor600.service.ts`, a service file started from the module next door: 69 commits
  with following on where the path itself had 61, and the eight extra belonged to two other
  modules, back through `wou065.service.ts` to `apr090.service.ts` - a different name in a
  different folder, three years earlier. Nothing on screen said so, which is what makes it worth
  turning off rather than explaining: a history of the wrong file still looks like a history.

  The **follow** switch is still there for a file you know was moved, and now says what it does.

- **A branch ticked in the sidebar stays ticked.** The two ways to tick a ref were written
  separately, and only the graph header's stopped following HEAD. The tree's own checkbox reached
  into the hidden set directly, so the next reload put the ticks back to "the branch you are on" -
  not immediately, which is why it survived being tried, but on the next fetch, commit, branch
  deleted, or the moment the graph tab regained focus. The same gesture worked in one place and
  quietly undid itself in the other. Both go through one path now, and *Clear Filters* lights up
  for a set picked in the tree, which it also had not been doing.

- **The graph stops scrolling back to the selected commit every time a file is saved.** The
  re-derive that follows a working-tree change ended by scrolling the selection into view, so
  picking a commit, scrolling off to read something else and saving a file yanked the list back.
  It now scrolls only when the row actually moved - a sort, or a reload that put it somewhere else -
  and not when the same commit is still in the same place with the uncommitted row appearing above
  it. This was harmless until `91c7ef5`: the message that triggers it had never been arriving, and
  fixing that subscription switched it on.

- **Two settings that were not settings.** `weft.pageSize` was offered in the Settings UI with a
  range, a default of 2000 and a description saying it was what you wait for on open - and read by
  nothing at all; the number in use was 500, written into the code. `weft.maxCommits` was the other
  way round: read, with a default of 250,000, and declared nowhere, so it never appeared in the
  Settings UI and writing it by hand earned an "Unknown Configuration Setting" squiggle for a
  setting that worked. Both are real now, and `scripts/settings-check.mjs` runs with the tests to
  keep them that way - every setting offered is read, every setting read is offered, and the
  default in the manifest matches the fallback in the code.

- **A history that stopped early says so.** `--max-count` stops git at the limit and exits 0, so a
  truncated walk looked exactly like a complete one: the oldest commits simply absent, lanes that
  would have closed further back running off the bottom, and a line in the corner reporting the
  limit as though it were the size of the repository. It now reads *stopped at the limit*, and says
  what that means on hover.

- **A failed walk says what git said.** stderr was drained into nothing and the failure was raised
  with an empty string for it, so every refusal read as the whole command line followed by
  `failed (128): (no output)` - an unknown revision, an invalid pattern from the regex toggle, a
  repository with no commits yet, all the same line. git's own message now comes with it, which
  also gives the remedies something to match: `fatal: command line, '[unclosed': Unmatched [ or [^`
  instead of nothing at all.

- **The lanes follow the theme.** The palette was read once, when the panel said hello, and never
  again - so switching VS Code from a dark theme to a light one repainted the rows, the ref badges
  and the author tints and left the lanes and the dots in the colours of the theme you had left.
  Half-updated, which reads as broken rather than as stale: the hollow merge dots took the new
  background inside the old strokes. The colours are read with everything else a frame reads now,
  and a change of theme asks for a repaint rather than waiting for a scroll to cause one.

- **Keys belong to whatever has focus.** Down in the branch quick-switch moved the highlight in its
  list *and* moved the selection in the graph and opened the details pane; Home in a text box
  jumped the commit list to the top while the caret stayed put. The three dropdowns had it worst -
  cancelling their default meant the arrow keys could no longer change what they were set to. The
  search box had always stopped this for itself; every box gets it now, including the ones added
  later.

- **A graph tab holds 19% less**, and the README no longer points at the wrong work. It said 68 MB
  of commit objects was more than an extension host should hold and that the answer was a columnar
  store. Measured against a real repository - 78,282 commits, 1,177 refs - both halves were wrong:
  the host holds 0.8 MB, because it maps a page, posts it and forgets it, and the columnar store
  was worth about 9% of a number that was in the other process.

  What the tab actually holds, measured per part, is written down now. The two things worth taking
  are taken: the lane points were an object per point and are now interleaved doubles, and the rows
  share one empty array for the commits that carry no ref and intern the author's name as it
  arrives - eighty-one distinct names were being held seventy-eight thousand times, because the
  structured clone at the boundary hands over a fresh copy of each. 69.2 MB to 55.9.

  And the thing that was hiding underneath: every field the parser produces is a *sliced* string,
  so keeping one sha keeps the whole page it was parsed from. Nothing retains them today - which is
  why nobody had seen it - but holding a sha and a subject per commit costs 900 bytes a row where
  flattened copies of the same two strings cost 205. Written down where the next cache will find it.

- **A group the rule made can be taken apart.** It folds by case and separators - `Max_Chiue` and
  `max_chiue` - because nine times in ten that is one person who configured git on two machines.
  The tenth time it is two people, and the list had no way of being told: right-clicking a group the
  rule had folded offered *Add to Group…* and nothing else, so the only thing you could do about a
  wrong fold was make it wronger.

  **Ungroup** now says so, on a whole group or on one spelling inside it - which is the case where
  three of four really are the same person - and **Group by Spelling Again** hands it back, because
  a correction that cannot be undone is a worse guess than the rule's.

  A row in the author list has four states now, and the menu is driven entirely by which one it is
  in, so a state with no entry of its own is a row whose only useful action is missing. That is what
  this was. Every state is checked against the menus with the tests.

## 0.6.0

- **Authors is two levels, and the groups can be made by hand.** A person who spells themselves
  four ways was one row reading `sean_lin, Sean Lin, SEAN_LIN, Sean_Lin` - a list pretending to
  be a name, and unreadable by the fourth. A person is now a row you can open, the spellings are
  the rows inside it, and a name that matched nobody else stays a plain row rather than becoming
  a group of one.

  Right-click to put a spelling, or a whole person, with somebody else - which is the answer
  where the rule cannot help: `Lineric` and `lineric_lin` share a prefix and nothing that can be
  proved, and a list that guesses is worse than one that shows a person twice. Removing the
  assignment hands the spelling back to the rule rather than inventing a third state, and the
  groups are remembered per repository, because they are a judgement about one set of people.

  Ticks moved to the spelling, so a group’s box is all of it at once and one spelling on its own
  is still a thing you can ask for.

- **Show File History reaches files, not just the list of changed ones.** It is on the right-
  click menu in the Explorer, on an editor tab and inside an editor, as well as where it
  already was. The tree could assume which repository a file was in and what git called it,
  because its files came out of a commit Weft had walked; a file picked anywhere else knows
  neither, so both are asked for - and a graph opens beside the file if there is none.

- The status bar item no longer wears git’s own branch icon. It cannot wear the extension’s
  either - a status bar item’s text takes the `$(codicon)` syntax and nothing else - so it is
  `circuit-board`: lines with nodes on them, which is the closest the set gets to what the button
  opens, and not something git is already using a few pixels away.

## 0.5.0

- **The blame annotations stand back while the repository is being written to.** A checkout
  rewrites the files that are open, VS Code reloads those documents, and a reload is a change
  event - so a checkout was the exact moment Weft ran `git blame`, over and over, on the
  repository being checked out. On Windows that is what turns a checkout into `unable to write
  symref for HEAD`: the branch stays where it was while the index and the working tree have
  already moved, so the whole difference between the two branches shows up staged. The older the
  branch, the more files change and the more often it happened.

- **A stash no longer drags its branch into a graph that excluded it.** A stash is a commit, and
  naming one puts everything it can reach into the walk with it - so ticking a single branch
  produced a graph full of commits from branches that had been unticked, with the stashes
  sitting at the top of it. A stash is drawn when the commit it was made on is somewhere the
  walk already goes, which is every stash while nothing is filtered and the ones that belong
  once something is.

- **The switch box asks before it switches**, and says how long since that branch moved. It is a
  text field with Return bound to "check that branch out" - the right shape for the gesture and
  one typo away from a checkout nobody wanted, which on a large repository is a minute of files
  being rewritten. The menus are not asked about: reaching Checkout there is already two
  deliberate steps, and a dialog on top of that is a click that teaches people to click through
  dialogs.

- **How long since each branch moved, beside its name** - in the switch box, in the header list
  and in Branches & Tags. A hundred and fifty branch names raise a question they cannot answer,
  which is which of them are still alive, and the answer matters most at the moment you are
  about to switch to one. It is the committer date, so a year-old commit rebased onto today is
  a branch that moved today, and it costs no extra git: one more field on the walk of the refs
  that was already happening.

- **Branches & Tags sorts by name or by most recently moved.** Alphabetical is how you find a
  name you already know; by most recent is the other question a hundred and fifty branches raise
  - which of these is anybody still working on - and it puts the answer at the top instead of
  scattered down the list beside the names. Neither order touches a tick or a walk.

- **List Only Ticked Branches & Tags.** Once a handful of refs out of fourteen hundred are
  ticked, the ticks are the answer to "what am I looking at" - and finding them again means
  scrolling past the one thousand three hundred that are not. It narrows the listing only: the
  graph is untouched, and the count beside each group keeps measuring against everything there
  is, so "1 of 148" does not quietly become "1 of 1".

- **The Branches & Tags title bar is five icons instead of nine.** It is a row of unlabelled
  pictures and VS Code draws no separator between them, so the only thing keeping it readable is
  its length. What stays is finding a name, applying that listing, and the three answers to "what
  should the graph draw"; the orderings and the ticked-only listing moved behind the ellipsis,
  where they are grouped, separated and - being words rather than pictures - actually legible.

- **Weft's own icon on the graph's tab, and on its Source Control button.** The tab carried
  whatever VS Code gives a webview that never asked for an icon, and the button sat in git’s own
  title bar wearing git’s own branch icon - so the one thing in that row that opens something
  else looked like one of them. A command’s icon can be a path as well as a codicon, and a tab
  icon is drawn as an image rather than as a mask, so both take the marketplace icon as it is.

## 0.4.0

- **Toggle File Blame** puts every line’s author and date in a column down the left, and takes
  it away again. Off unless asked for, and asked for per file: it moves the code right and
  gives the eye a second column to read, which is worth it while you are reading a file’s
  history and in the way while you are writing it. The column is measured to its widest name,
  because a ragged edge stops a column reading as one. It is on the editor’s right-click menu.

- **The Date column shows the time once it is wide enough for it.** The day is what a history is
  read by, and four thousand rows carrying a time nobody asked about is noise - but two commits
  an hour apart on the same day are indistinguishable without it, which is the moment anybody
  widens the column. So the format follows the width rather than a setting. The whole timestamp,
  offset included, is on hover at any width.

## 0.3.0

- **Who last changed this line, at the end of the line.** The cursor’s line only: annotating
  every line turns a file into two columns and makes the code the narrower one, while the line
  being read is where "why is this here" gets asked. It follows the buffer rather than the file
  on disk, so a line typed a moment ago says so instead of wearing the name of whoever wrote
  what used to be there. Hovering it gives the sha, the date, and **Show in the graph**, which
  opens one beside the file with the cursor already on that commit - it waits for the page that
  carries it rather than missing, and says so if a filter is keeping the commit out.
  `weft.inlineBlame` turns it off.


- **A graph opens on the branch you are on.** Every ref used to be ticked, which on a clone with
  fourteen hundred of them is seconds of `git log --all` to draw a graph whose lanes are too many
  to count, let alone read - and the branch you opened it for is somewhere in the middle of them.
  A checkout moves the ticks to the branch you switched to, whatever they were, because a graph
  still drawing the branch you left is drawing the wrong thing. Between checkouts the ticks are
  yours: the first one you move stops the default applying, and Clear Filters hands it back.
  **Show All Branches & Tags** still means all of them, and the default is not reported as a
  filter, so the button that drops filters is not lit on a graph nobody has filtered.

- **only here**, beside first parent: walk what the ticked branches have and no other ref does.
  Ticking one branch narrows where git *starts*, which on a branch cut off a trunk with three
  hundred others merged into it narrows almost nothing - everything merged in is still reachable,
  labels and lanes and all. This is the question that looked like it was being asked: what is on
  this branch and nowhere else.

- **Untick All Branches & Tags, and Show Only the Current Branch**, beside the one that ticks
  everything. Ticking three refs out of fourteen hundred starts by unticking the other one thousand
  three hundred and ninety-seven, and doing that a box at a time is not a gesture anybody
  completes. The same three sit in the graph's header as well: which branches are drawn is a
  question asked while looking at the graph, and the sidebar that also answers it is a section in
  another panel that may well be collapsed.

- **A box in the header switches branches.** Type a name, arrow up and down to aim, Return or a
  click to check out, Escape to give it up. On a repository with a hundred and fifty branches,
  opening a menu and hunting for a name was the whole cost of the gesture.

  Its list is its own, not the dropdown beside it. That one answers "which branches should the
  graph draw" - every row is a tick box and a name, two targets meaning two different things - and
  a list where the obvious thing to click is the wrong one is not a list you can switch with.

- **Checkout on a remote branch goes to the branch it names.** With a local branch of that name
  already there - which is the ordinary state of `origin/uat` beside `uat` - it used to refuse
  with "local branch already exists", a reason that is true, is not a problem, and reads like "you
  are already on it". From the sidebar the refusal was posted to the graph and nowhere else, so
  right-clicking a remote branch and choosing Checkout did nothing at all and said nothing about
  it. It now checks the local branch out, creates and tracks one when there is none, and refuses
  only when that branch is the one you are on. Any action run from the sidebar now says so where
  the person who started it is looking.

- **A checkout that could not move HEAD says what it left behind.** Windows refuses to rename a
  lock over a file another process has open - an antivirus scanner, an indexer, or Weft's own
  `git status` answering a filesystem event it caused - and git reports it as
  `unable to write symref for HEAD`. It has already swapped every file over by then, so the branch
  stays put while the working tree holds the other one's contents; Weft now says so and offers to
  run the checkout again, which finishes the switch. It also no longer reads a repository while it
  is writing to one, which is what put it in the way of its own checkout.

- **One row per author, and the count is theirs.** Someone who has committed from two addresses -
  a laptop and a build box, which is every repository without a `.mailmap` - was two rows that
  looked identical, ticked as one, and shared a tree item id, so one of them was drawn twice
  wearing the other's number. Addresses are now folded into the name they were committed under,
  which is what the tick has always filtered by, and so are spellings that differ only in case or
  separators: `Sean Lin`, `sean_lin` and `SEAN_LIN` are one person who has configured git three
  times. The row shows every spelling it covers, and how many addresses are behind the number.

  It stops there. `Lineric` and `lineric_lin` share a prefix and nothing that can be proved, and
  the address is not a key either - one service account is a dozen people's commits. Ticking a
  folded row names every spelling to `git log`, so the count on the row is exactly what the graph
  then walks.

- **The author list can be sorted by name**, for when you know who you are looking for, and back by
  commits, which is where it starts. The count itself is the whole history, back to the root
  commit, and takes no notice of what the graph is narrowed to - the row says so on hover.

- **The author filter is visible while it is on.** It is typed into a picker that closes behind
  itself, so what you typed now sits beside the section's title until you clear it. A filter you
  cannot see is one you forget is on, and a list missing half its people looks broken.

- **The lanes ask for the room the rows on screen need**, rather than the room the widest row in the
  history needed. A repository with a hundred branches was reserving a column that was mostly blank
  wherever you happened to be reading, and squeezing the handful of lanes in front of you to fit a
  box they would have filled comfortably.

- **The HEAD ring and the working tree's dot are drawn on their lane** rather than beside it. Both
  missed the squeeze that narrower lanes are drawn with, so on any graph wide enough to be squeezed
  the ring sat off its own dot and the dashed line to the working tree ran down a column no lane
  was in.

- **Checkout is the first thing on a branch's menu**, and copying a name is the last. Nobody
  right-clicks a branch to copy its name, and Checkout sitting third meant reading past two things
  that were not it. Comparing stays where it is: on a commit it is a real answer to "what do I want
  to do with this", not an afterthought like the clipboard.

- The commit-order dropdown takes the theme's colours, like the two beside it. It had been left to
  the browser's own, which on a dark theme is a white box in a dark toolbar.

## 0.2.0

- **The lanes no longer take the whole panel.** They are capped at a third of it by default and
  have a grip of their own, and when given less room than they want they are drawn closer together
  rather than cut off.

- **More than one repository in a workspace.** Opening the graph asks which one; each gets its own
  tab, and the sidebar follows whichever is in front while remembering what you ticked in the
  others. Filters are answered per repository - before this, unticking a branch in one graph
  reloaded every other open graph with a list of ref names that do not exist in it.

- **Authors** can be filtered by text, the way branches and tags already could - typing narrows who
  is listed without changing what the graph walks, and **Show Only Who Is Listed** applies the
  listing to it in one click.
- Merging now asks whether to fast-forward or record a merge commit - but only when the branch is
  strictly behind, which is the only case where both are possible.
- **Squash** a branch into the working tree, as its own action. It stages the changes without
  committing, and warns that git will still consider the branch unmerged afterwards.
- A staged squash is recognised as an operation in progress. It leaves no `MERGE_HEAD`, so
  `git merge --abort` refuses it; the banner offers `reset --merge`, which is what actually
  undoes one.

## 0.1.2

- The marketplace description said "read-only", which stopped being true several milestones ago.
  The README was corrected at the time and the manifest was not, so the one line every visitor
  reads first was the one line still claiming the extension only looks.
- Moved building and testing out of the README and into `CONTRIBUTING.md`. The marketplace renders
  the whole README, so the extension's own page was opening on `npm install` - instructions for
  working on it, shown to everyone deciding whether to use it.

0.1.1 was tagged with the first of these and superseded before it was uploaded.

## 0.1.0

The first published version. Everything below is what it does; nothing has shipped before this, so
there is nothing to have changed.

### Reading

- A commit graph with branches, merges, tags, remotes, stashes and HEAD, over ordinary clones, bare
  repositories, linked worktrees and submodules
- Streaming load: the first rows paint while git is still walking. On a 100,000-commit repository
  the first page is on screen in 622 ms and the whole history is laid out in 1.1 s
- Virtualized rendering, so a 20,000-row history keeps 31 row elements in the DOM
- A row for the working tree above the history, hanging off HEAD by a dashed line, that keeps up as
  files are saved without re-walking anything
- Where the branch stands against the one it tracks, and how old that answer is
- Commit details, and what a commit changed in the **Commit Files** section - as a folded tree or a
  flat list, with the diff a click away
- One file's history, with renames followed
- Search by message, author, committer, content or path, with case, regex, all-terms and invert
- A date range, a first-parent walk, and a choice of commit ordering: by commit date, by author
  date, or topological
- Comparing two commits, either through the menu or by ctrl-clicking the second one

### Writing

- Checkout a branch, a remote branch, or a commit
- Create, rename and delete branches; create and delete tags
- Stash, apply, pop and drop
- Merge, rebase, cherry-pick and revert, with a banner for whatever is unfinished and a way out of
  it
- Reset, in all three of its forms, each labelled by what survives rather than by its flag
- Fetch, pull and push, using whatever credential helper is already configured. Pull asks whether to
  merge or rebase only when the histories have actually diverged
- Force push as `--force-with-lease` after a fetch, never `--force`
- Delete a branch on a remote, which is a push and says so
- Add, rename, repoint and remove remotes

Anything that could destroy uncommitted work names the files it would destroy before asking.

### Getting around

- Branches and tags in Source Control, with a tick each for whether the graph draws them
- A branch menu in the header: the same ticks, and a click to check one out
- Author colours derived from the name, so they never shift as pages stream in
- Columns that resize and hide, a draggable split above the details pane, and a filter state that
  survives the tab being hidden
