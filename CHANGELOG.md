# Changelog

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
