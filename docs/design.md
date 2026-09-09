# How Git Weft is built, and what it costs

Why it is put together the way it is, and the numbers behind the claims. The
[README](../README.md) links here rather than carrying it, because these are answers to questions
somebody asks second.

## Design notes

**The layout is resumable.** Lane assignment is a single forward pass, so its entire continuation is
`{open lanes, colour queue, row index}`. Holding that in a `LayoutState` means page N+1 is laid out
without touching a row of pages 1..N — which is what makes a large repository viable, and has the
side effect that a commit's colour never changes once assigned.

**Lanes are polylines that only turn.** A lane running straight for a thousand rows costs two
points. Measured on a 100k-commit repository: 100,000 rows of graph, 7,998 points.

**The network actions are not the ones Source Control already has.** They look like duplicates and
are not: `git.fetchOnPull` is off by default, so the built-in pull fetches only the branch it is
about to merge and leaves the rest of the graph as stale as it found it. Weft's fetches the whole
remote, then re-reads the counts before deciding anything. `git.rebaseWhenSync` is off too, so a
divergence becomes a merge commit without being mentioned; Weft asks, and says what rebase does to
the hashes before it does it. Behind but not ahead is `merge --ff-only`, so there is no accidental
merge commit at all. The buttons are the duplication; the behaviour is the reason.

**A remote-tracking ref is a local pointer.** `origin/main` moves when something fetches and at no
other time, so every ahead/behind count is a statement about the last fetch rather than about now.
Three hours offline and `↓0` still means "nothing had arrived three hours ago" - which read without
a timestamp means "you are up to date", and that is the whole way a graph misleads about a remote.
So the age travels with the counts and stays on screen when they are zero, because zero is the
number most likely to be believed. `FETCH_HEAD`'s mtime is the answer, and costs one `stat`.

Acting on those counts is a separate problem, and solved separately: pull fetches the whole remote
first and then *re-reads* the counts before deciding anything, because the ones it was given are
stale by definition.

**The working tree is watched by someone else.** `RepoWatcher` watches `.git`, which is where a ref
moving shows up and is deliberately not where a file being saved does - watching a whole worktree
means an event per keystroke of an editor's autosave. So the working-tree row listens to the
built-in git extension instead, which is already running `git status` on its own debounce. What it
triggers is one `git status`, not a reload: saving a file changes nothing a walk would produce
differently, and re-walking would be paying for the whole graph to move one row's worth of text.

**The working tree is a row, not a commit.** It is built in the view rather than sent by the host,
and deliberately kept out of the lane layout: a lane point's Y *is* a commit's row index, so a row
that appears and disappears as files are saved would renumber every one of them and force a
re-layout of the whole history. Instead it takes display position zero and the canvas shifts down
by one - one number, no re-layout, and a dashed line to say that nothing up there is reachable yet.

**The pane is for the commit, the sidebar is for its files.** The details pane is wide and short;
a file list is narrow and tall. Ten files in a 200px strip under a 20,000-row history was the wrong
shape for both, so the list is a tree view now - which also means folding, status colours and
one-click opening come from VS Code rather than from three hundred lines of webview.

**The checkboxes are Weft's, not VS Code's.** A tree view manages checkbox state itself unless
told otherwise, and what it means by a ticked parent is "every child is ticked" - which it will
enforce at the next render. Weft means something else by a ticked group: "some of these are
showing". The two disagreeing looked like unticking a branch putting its own tick straight back on,
and the fix is one flag saying who owns them.

**`--follow` will not take a pathspec with magic in it.** `git log --follow -- ':(icase)src/x.ts'`
is not a quieter answer, it is `fatal: pathspec magic not supported by --follow`, and it takes the
whole walk with it - which matters because a path search is case-insensitive by default, so the
obvious combination is the broken one. Following renames therefore matches the path exactly, and
the case switch is shown locked on rather than offering something git will refuse.

**git's date flags need spelling out.** A bare `--since=2026-07-24` is not midnight: approxidate
fills the unspecified fields from the current clock, so run at 20:08 it means that evening - and
answers differently an hour later. Measured, it returned one commit from a day that held twelve.
`--until=<day>` likewise means *before* that day. Both bounds are sent with an explicit time, and
the lower one as `--since-as-filter` where git is new enough (2.37): plain `--since` stops walking
at the first commit older than the cutoff, which hides newer commits behind an older one in a
history whose dates are not monotonic. That gives up the early exit, which streaming makes
affordable - rows still appear as they are found.

**git's regexes are basic ones, not the ones you think in.** `--grep`, `--author` and `-G` are
POSIX *basic* regular expressions, where `+ ? ( ) { } |` are literal until you escape them - `\+`
is the one-or-more operator. Escaping a name the JavaScript way turns `C++` into a pattern meaning
something else and `A|B` into two different people, so the escape is one named function with the
dialect written down beside it. `--fixed-strings` would do the job, and is not used: it is a global
flag, so it would also reach the `--author` arguments the Authors sidebar contributes.

**Y is measured in rows, not pixels.** A point at `y` is drawn at `y * rowHeight - scrollTop`, so
the canvas stays locked to the row text and changing the row height needs no re-layout. It is also
why sorting hides the graph rather than redrawing it: reorder the rows and the text slides out from
under lines that are still where the layout put them.

**One streaming `git log`, not paged calls.** Paging with `--skip=N` makes git re-walk N commits per
page, which is quadratic across a full scroll; separate calls can also straddle a ref update and
produce a history that contradicts itself. One long-lived process walks a single consistent
snapshot and the graph paints as records arrive.

## Measurements

On a synthetic 100,000-commit repository (`scripts/make-fixture.mjs`), Windows 11, git 2.55:

| | |
| --- | --- |
| First page on screen | 622 ms |
| Full history walked and laid out | 1.1 s |
| Throughput | ~90,000 commits/sec |
| Graph points for 100k rows | 7,998 |
| First row: commit date / author date / topological | 521 / 551 / 517 ms |

The three orderings cost the same, which is worth saying because it sounds as though they should
not. All three make git read the history before it emits a row, so none of them is the cheap one -
and git's own chronological order, which *is* cheap, is not on offer: it can put a parent before its
child under clock skew, and the lane layout cannot survive that. The choice is which shape the
history reads best in, not what it is worth waiting for.

### Memory

This section used to say that 68 MB of commit objects was more than an extension host should hold,
and that the next thing to do was a columnar store. Both halves were wrong, and finding out took
one afternoon of measuring against a real repository - 78,282 commits and 1,177 refs.

**The host holds almost nothing.** It maps a page into rows, posts it, and forgets it. Walking that
whole history while keeping nothing costs 0.8 MB. The 68 MB was a harness holding what the host
hands over, which is not a thing the extension does.

**The tab is where the history lives**, and it is measured per part:

| | before | now |
| --- | --- | --- |
| rows | 37.6 MB | 32.3 MB |
| lanes (19,899 of them, 186,723 points) | 17.0 MB | ~9 MB |
| dots (one per commit) | 9.1 MB | 9.1 MB |
| merge arcs | 2.9 MB | 2.9 MB |
| row widths | ~0 | ~0 |
| **a graph tab, all told** | **69.2 MB** | **55.9 MB** |

The lane points were `{ x, y }` objects and are now interleaved into a plain array of doubles -
sixty-odd bytes a point down to sixteen, and V8 keeps such an array unboxed. The rows share one
frozen empty array for the commits that carry no ref, and intern the author's name on arrival:
eighty-one distinct names were being held seventy-eight thousand times, because the structured
clone at the boundary hands over a fresh copy of each.

**And the trap that was hiding underneath it.** Every field the parser produces comes out of
`String.split`, and V8 answers that with a *sliced* string - a pointer into the parent. Keeping one
sha keeps its whole record; keeping the record keeps the page it was parsed from. Measured: holding
a sha and a subject per commit costs 900 bytes a row, and holding flattened copies of the same two
strings costs 205. Nothing retains them today, which is why nobody had seen it - but a cache added
without knowing would pay 4.5x for the privilege, and no rearrangement of the row would touch it.

The columnar store the old note recommended was measured too, end to end: 75 MB down to 68, about
9%. Days of invasive work across sorting, filtering, selection and comparison, for a twelfth of a
number that was in the other process.
