# Everything Git Weft does

The [README](../README.md) has the short version. This is the long one, kept apart because a
landing page that lists two hundred things tells you nothing about any of them.

## Working

- Commit graph with branches, merges, tags, remotes and HEAD
- Ordinary clones, bare repositories, linked worktrees and submodules
- More than one repository in a workspace: opening the graph asks which, one graph per repository,
  each its own tab. **Branches & Tags** and **Authors** follow whichever graph you are looking at,
  and remember what you had ticked in the others
- Streaming load: the first rows paint while git is still walking
- Virtualized rendering: a 20,000-row history keeps 31 row elements in the DOM, and a frame of the
  graph is measured rather than assumed - 0.7ms at the median on 78,000 commits and 1,177 refs,
  1.5ms at the ninetieth, 2.7ms at its worst
- A row for the working tree when there is one, above the history and hanging off HEAD by a dashed
  line, with what is staged, unstaged and untracked. Click it and the same **Commit Files** section
  lists them; click a file and the diff is HEAD against the file as it is on disk. It keeps up with
  the tree as you save, without re-walking the history to do it
- Where the branch stands against the one it tracks, and how old that answer is:
  `main ↑2 ↓1 fetched 3h ago` beside the title. The age is not decoration - see the design note
- Right-click a local branch or a tag in **Branches & Tags** to delete it. A remote branch gets a
  separate entry, **Delete on Remote...**, because it is a push to a server rather than a change to
  this clone - the confirmation says which remote, what stops being reachable there, which local
  branches are left tracking nothing, and that there is no reflog on the far end
- Order the walk by commit date, author date, or topologically - the dropdown beside the search.
  Topological keeps a branch's commits together instead of interleaving them by date, which on a
  history with concurrent branches is a different graph within a handful of rows
- Fetch on a timer if you want one (`weft.autoFetchMinutes`, off by default). Weft also picks up
  fetches it did not run, including VS Code's own `git.autofetch`: the watcher sees the refs move
- Click or arrow-key a commit for its message and metadata; what it changed lands in the **Commit
  Files** section in Source Control, as a folded tree or a flat list
- One file's history: right-click it in **Commit Files** for **Show File History**, and the graph
  narrows to that path. Renames are not followed unless you ask: `--follow` detects copies as well,
  so a file scaffolded by copying its neighbour is followed into the neighbour's history without
  saying so. The `follow` switch is there for a file you know was moved
- The branch button in the header chooses which branches the graph draws - the same ticks as in
  **Branches & Tags**, not a second copy. A name is its tick's label, so clicking either does the
  same thing, and neither ever checks anything out. What the graph is drawing sits in a **Drawn**
  section at the top, local and remote together and each saying which it is; the rest follow under
  Local and Remote, in the order Branches & Tags is sorted by. Local and Remote roll up, and each
  heading has a tick for all of them - which acts on what the filter box has left listed, so
  narrowing and then unticking hides exactly what you can see
- Right-click to copy: a commit's hash or subject, a branch or tag's name - and its full ref name,
  which is the one git resolves rather than the one you read. Files in **Commit Files** copy their
  path either way round, relative or absolute
- Compare two commits: right-click one for **Select for Compare**, then another for **Compare
  with …** - the two steps VS Code's own file compare uses, and ctrl-click does the same pair
  without the menu. The Commit Files section fills with what they differ by, and the pane says how
  far apart they are: a count for each side, because two commits picked off a graph are not always
  one behind the other. The marked commit stays named in the title bar and one click goes back to
  it, because the two commits worth comparing are rarely both on screen - and the mark is held by
  hash, so searching for the far one does not throw it away. Escape drops both
- Click a file there to open it in VS Code's own diff editor, renames included
- Search by message, author, committer, diff content (`-G`) or path, pushed down into `git log`.
  Match case, regular expression, all-words and invert are switches inside the box, each offered
  only in the modes where git can honour it - and text is the default, so `v0.4.1` no longer
  quietly also matches `v0X4Y1`. Paste a hash instead and it selects that commit rather than
  grepping for it, and whatever matched is marked in the row
- Author mode and the **Authors** ticks narrow each other rather than adding up. Two controls, one
  `git log` flag, and git reads several `--author` as "any of these" - so ticking one person and
  typing another used to hand back both. Typing now picks out the ticked people the query also
  matches, read in git's regex dialect rather than JavaScript's, and matching nobody means nobody
  rather than everybody
- A **first parent** switch: walk the mainline and leave out what was merged into it, which also
  takes the merge arcs with it rather than leaving them pointing at rows that are no longer there
- A date filter beside the search: today, the last 7, 30 or 365 days, or a custom range. It narrows
  the walk like every other filter here, and combines with them - "what did Ada touch today" is one
  question. It compares git's committer date rather than the author date the column shows, which is
  the same thing except for rewritten history
- One button drops every filter at once - the search, the date range, and the branch and author
  ticks in Source Control - and it is on screen only while there is something to drop. The sort is
  left alone: it hides nothing, and it has a way back of its own
- Auto-refresh: commit from a terminal and the graph reloads itself
- A repository where `git status` is slow gets one offer to turn on git's untracked cache - and its
  filesystem monitor, where git says one can run. Never for This Repository is remembered, a
  setting somebody already chose is left alone, and `weft.statusSlowMs` says what counts as slow
- Right-click to act: checkout (branch, remote branch, or a commit detached), create and rename
  branches, create lightweight or annotated tags, delete branches and tags. A checkout asks first,
  wherever it was started - the graph, its menus or Branches & Tags - and one that detaches HEAD
  says so
- Merge and rebase, with a banner while either is unfinished: Continue, Skip, Abort, and the
  conflicted files as links into VS Code's merge editor
- Cherry-pick, revert, and reset (soft, mixed or hard) from any commit
- Stashes appear in the graph, with apply, pop and drop on the row and a Stash Changes command
- Column headers, and a click on one sorts by description, author, date or commit. A sorted list is
  flat: a lane's Y coordinate is a row index, so in any order but git's the lines would join commits
  that are no longer neighbours. A third click puts the graph back
- A graph opens on the branch you are on, and a checkout takes it with you. Everything else is
  unticked until you say otherwise: a clone with fourteen hundred refs spends seconds walking all
  of them to draw a graph so wide that the branch you came to look at is one lane among hundreds.
  **Show All Branches & Tags** is one click away, and between checkouts the ticks are yours - the
  first one you move stops the default applying, and Clear Filters hands it back. Switching branch
  starts again from the new one, hand-picked set included: a graph still drawing the branch you
  left is drawing the wrong thing. The ticks are kept for each repository, across sessions, and a
  set picked as only these leaves a branch that arrives later unticked - after Show All, whatever
  arrives is drawn
- Presets: **Branch Presets…**, in the "…" menu of the **Branches & Tags** title bar, saves the ticks
  under a name, draws a saved set again in one pick, and deletes one. Each keeps its choice - a set
  saved as only these still leaves
  out a branch fetched later - and they are kept for each repository
- Three buttons for the three answers worth one click - everything, nothing, and the branch you are
  on - over the branch list and again in the graph's own header. Ticking three refs out of fourteen
  hundred starts by unticking the rest, which is not something anybody does a box at a time
- A box in the header switches branches: type a name, arrows to aim, Return or a click to check
  out - it asks first, and says how long since that branch moved - and Escape to give it up. Its list is plain - one row, one thing, and clicking it goes there.
  The button beside it is the other question, and keeps its own list of ticks: which branches the
  graph should draw
- Who last changed the line the cursor is on, greyed at the end of it, with the commit’s
  subject and how long ago. One line rather than all of them: the file still looks like a file.
  It blames the buffer, not what is on disk, so unsaved edits do not shift every annotation
  below them onto the wrong line - and the line you just typed says so. Hover it for the sha and
  the date, and for **Show in the graph**: a graph beside the file with the cursor on that commit,
  waiting for the page that carries it if it is forty thousand rows down. `weft.inlineBlame`
  turns it off
- **Show File History** on any file - in the Explorer, on a tab, inside an editor, or in the
  changed-files list - narrows the graph to the commits that touched that path
- **Show Line History**, on the editor’s right-click menu: the commits that touched the selected
  lines, in a section of its own beside the graph. Not the file’s history narrowed down - a commit
  that changed a different part of the same file is not in it, and a line that moved is followed to
  where it moved. It answers from HEAD, because `git log -L` walks from one commit and “the history
  of these lines” is a different question on a different branch. Click a row to find that commit in
  the graph
- **Toggle File Blame**, on the editor’s right-click menu, puts every line’s author and date in
  a column down the left. Off unless asked for, and per file: it moves the code right and gives
  the eye a second column, which is worth it while reading a file’s history and in the way while
  writing it. The two annotations share one blame, so having both on costs one `git blame`
- **only here** walks what the ticked branches have and no other ref does. Ticking a branch narrows
  where git starts, not what it reaches - a branch cut off a trunk with three hundred others merged
  into it still reaches all of them, which is not what "show me this branch" looks like it means
- Two filters in the Source Control sidebar: untick branches, remotes or tags to keep them out of
  the walk, and tick authors to show only theirs. Both narrow what `git log` walks rather than
  hiding rows
- Right-click a branch there to check it out, or to **Show Only This** - unticking narrows the tips
  git walks *from*, so hiding one branch changes nothing while its commits are still reachable from
  another, which for a merged branch is always
- The text filter over that list is a way to find a ref, not a way to filter the graph, and the
  message under it says so with the numbers: `Listing 1 of 24 refs matching "claude/". Nothing is
  unticked, so the graph still walks all 24.` One button applies the listing to the graph when that
  is what you meant
- Branches & Tags sorts by name or by most recently moved - alphabetical to find a name you know,
  by date to see which of a hundred and fifty branches anybody is still working on
- Every branch says how long since it last moved, wherever it is listed - the switch box, the
  header list, and Branches & Tags. Which of a hundred and fifty branches are still alive is the
  question a list of names cannot answer, and it matters most just before you switch to one
- A text filter for the branch list itself, for repositories with more refs than fit on screen,
  and a button that lists only what is ticked - on a clone with fourteen hundred refs the ticks
  are what you are looking at, and finding them again is otherwise a scroll past everything else.
  Both narrow the listing and leave the graph alone
- **Authors** has the same filter the branch list has, for the same reason: on a repository with
  two hundred contributors, finding the one you want is what stands between you and ticking them.
  Narrow to a name, a surname or a company's email domain, then one button shows the graph exactly
  the people left listed. What you typed stays beside the section's title while it applies, because
  a filter you cannot see is one you forget is on
- One row per person in **Authors**, opening onto the spellings it is made of - `Sean Lin`,
  `sean_lin`, `SEAN_LIN` are one row and three rows inside it, rather than one row with all
  three names in it. Right-click to group two the rule will not join, to take one back out, or to
  ungroup two it folded together that are not one person after all - and to hand that decision back
  to the rule later. All of it remembered per repository. Ticking the person ticks every spelling, and a spelling
  can be ticked on its own
- A group is a label rather than a box. Somebody on the platform team and on the release rota is in
  both, listed under each and saying on the row where else they appear; removing them from one
  leaves the other alone. Two groups sharing a person each count that person's commits, because
  each of them would walk those commits - any other number would be one no tick of the row produces
- Sorted by commits or by name. Several addresses, or several spellings of one
  name - `Sean Lin`, `sean_lin`, `SEAN_LIN` - are one row and one count, with every spelling shown
  on it. Ticking that row names all of them to `git log`, so what it counted is what the graph
  walks. Names that differ by more than case and separators are left alone, and a shared address
  merges nothing: one service account is a dozen people. The count covers the whole history back to
  the root commit and does not move when the graph is narrowed to a date range or a branch
- Each author gets their own colour, derived from the name so it never shifts as pages stream in
- **Git Weft: Manage Remotes...** in the command palette lists what each remote points at, and
  adds, renames, repoints or removes one. Adding fetches it; removing says how many
  remote-tracking branches go with it
- Merging asks how only when there is something to ask: a branch that is strictly behind can
  fast-forward or take a merge commit, and one that has diverged can only do the latter, so it is
  not offered a choice of one. **Squash** is its own entry rather than a third option, because it
  declines to join the histories at all - it stages the changes and leaves the commit to Source
  Control, and says up front that git will still call the branch unmerged afterwards
- Fetch, pull and push, using whatever credential helper is already set up - Weft never asks for
  a password and never stores one. Pull asks whether to merge or rebase only when the histories
  have actually diverged, and force push is `--force-with-lease` after a fetch, never `--force`
- The lanes get at most a third of the panel until you say otherwise, and a grip of their own to say
  it with. A history with thirty concurrent branches wants three hundred and sixty pixels of graph,
  which on a side panel is the whole width - and the subject column, which is what people came to
  read, becomes `feat(s…`. Given less room the lanes are drawn closer together rather than cut off:
  a graph missing its right-hand branches is a graph lying about the history. What they ask for is
  what the rows on screen need, not what the widest row in the history needed - the widest row in a
  repository with a hundred branches is almost never the one you are reading, and paying its width
  everywhere means a column that is mostly blank and lanes squeezed for no reason
- The Date column shows the day, and the time as well once it is dragged wide enough to hold it -
  the format follows the width rather than a setting, because widening that column is already the
  gesture for "these two are on the same day and I need to tell them apart". The whole timestamp
  with its offset is on hover at any width
- Drag the line between two column headings to resize a column, double-click it to put the width
  back, and right-click the headings to switch Author, Date or Commit off. Description stays: it is
  the `1fr` the others leave their space to, and the column people came to read. All of it is
  remembered across panel reloads
- Draggable split between the graph and the details pane, remembered across panel reloads

Anything that could destroy uncommitted work names the files it would destroy before asking, and
nothing passes `--force` by default.
