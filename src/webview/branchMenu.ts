/**
 * The branch dropdown, the quick-switch box, and the three ref presets beside them.
 *
 * All of it is the same question asked two ways, which is why it is one module: the dropdown asks
 * "which branches should the graph draw", every row a tick and a name; the box asks "where do I
 * want to be", every row one thing. They were one list once, and the obvious thing to click was the
 * wrong one.
 *
 * It owns its elements, its state and its listeners. What it does not own is where the messages go
 * or where its rolled-up groups are remembered - those arrive in `connect`, because the view is
 * what talks to the host and the view is what saves state.
 */

import type { RefEntry, RefsPresetEntry, WebviewMessage } from '../protocol.ts';
import { describeAge } from '../git/blame.ts';
import type { BranchFolders, Folded } from '../git/refFolders.ts';
import { foldRefs, foldingFor } from '../git/refFolders.ts';
import { span } from './dom.ts';

const branchButton = document.getElementById('branch-button') as HTMLButtonElement;
const branchCurrent = document.getElementById('branch-current') as HTMLElement;
const branchList = document.getElementById('branch-list') as HTMLElement;
const branchFilter = document.getElementById('branch-filter') as HTMLInputElement;
const branchRows = document.getElementById('branch-rows') as HTMLElement;
const branchEmpty = document.getElementById('branch-empty') as HTMLElement;
const branchJump = document.getElementById('branch-jump') as HTMLInputElement;
const jumpList = document.getElementById('jump-list') as HTMLElement;
const jumpRows = document.getElementById('jump-rows') as HTMLElement;
const jumpEmpty = document.getElementById('jump-empty') as HTMLElement;
const refPresets = document.getElementById('ref-presets') as HTMLElement;
const branchPresets = document.getElementById('branch-presets') as HTMLElement;

/** Where a message goes. Set by `connect`, so this module never reaches for the host itself. */
let post: (message: WebviewMessage) => void = () => undefined;

/** Called when a group is rolled up or down, because remembering that is the view's job. */
let remember: () => void = () => undefined;

/*
 * The branch menu in the header: which refs the graph draws.
 *
 * Every ref the sidebar knows about, with the tick that decides whether it is drawn. The same ticks
 * as in Branches & Tags, reachable without the sidebar open - which matters because the branch you
 * want to find is usually the one not on screen.
 *
 * It checks nothing out. It used to: the name beside each tick was a button that switched branch,
 * so two different things sat one pixel apart and the destructive one had the bigger target and no
 * confirmation - while the quick-switch box beside it, which is the same gesture done deliberately,
 * asks first. A menu whose every other control filters is not where a checkout belongs.
 *
 * The list is whatever the host last sent. Nothing is cached across repositories and nothing is
 * computed here: the ticks are the sidebar's state, and a toggle goes straight back to it.
 */
let refEntries: readonly RefEntry[] = [];
let headBranch: string | null = null;

/** The named sets of ticks the host last sent, drawn as a chip each above the list. */
let presetEntries: readonly RefsPresetEntry[] = [];

/** How to fold the lists, as the host last said: the same setting the sidebar folds by. */
let folderSetting: BranchFolders = 'auto';

/** Which folders are open. They start closed: what a folder is for is what it keeps out of the way. */
let branchFoldersOpen = new Set<string>();
let branchGroupsClosed = new Set<string>();

function branchMenuOpen(): boolean {
  return !branchList.hidden;
}

/**
 * Straight to the host, which owns the one hidden set.
 *
 * One message however many refs it is: the reload that follows sends the list back, so nothing here
 * has to guess what the new state is, and a group of fifty costs one walk rather than fifty.
 */
function setRefsDrawn(refNames: readonly string[], visible: boolean): void {
  if (refNames.length > 0) {
    post({ type: 'setRefsVisible', refNames, visible });
  }
}

function closeBranchMenu(): void {
  branchList.hidden = true;
  branchButton.setAttribute('aria-expanded', 'false');
}

/** One row: a tick that hides, and a name that checks out. */
function branchRow(entry: RefEntry, sayKind = false, display = entry.label, depth = 0): HTMLElement {
  const row = document.createElement('div');
  const here = entry.kind === 'local' && entry.label === headBranch;

  row.className = `branch-row${here ? ' current' : ''}${entry.visible ? '' : ' off'}`;

  // Inside a folder: indented by how deep, through a property rather than an inline style.
  if (depth > 0) {
    row.style.setProperty('--depth', String(depth));
  }

  const draw = document.createElement('input');
  draw.type = 'checkbox';
  draw.className = 'branch-draw';
  draw.checked = entry.visible;
  draw.title = entry.visible ? `Stop drawing ${entry.label}` : `Draw ${entry.label}`;
  draw.setAttribute('aria-label', draw.title);
  draw.addEventListener('change', () => {
    setRefsDrawn([entry.refName], draw.checked);
  });

  /*
   * The name is the tick's label, so clicking it is clicking the tick.
   *
   * A checkbox is a four-millimetre target next to a branch name that is thirty. Leaving the name
   * inert meant the easy half of the row did nothing and the hard half did the thing you wanted -
   * and for a while the easy half did something else entirely.
   */
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'branch-name';
  name.textContent = display;
  name.title = `${entry.refName}\n\n${draw.title}`;
  name.addEventListener('click', () => {
    setRefsDrawn([entry.refName], !entry.visible);
  });

  row.append(draw, name);

  if (sayKind) {
    row.append(span('branch-kind', entry.kind === 'remote' ? 'remote' : 'local'));
  }

  if (entry.updated > 0) {
    row.append(span('branch-age', describeAge(entry.updated)));
  }

  if (here) {
    row.append(span('branch-here', 'here'));
  }

  return row;
}

/**
 * A group heading: a tick for all of them, a label that rolls the group up.
 *
 * The tick acts on what is *listed*, not on everything of that kind, so it composes with the filter
 * above it - type `claude`, untick Local, and the eight branches you can see are the eight that
 * stop being drawn. Acting on the hidden ones too would make the same click mean something
 * different depending on a box the user can see the contents of.
 */
function branchGroupHeader(kind: string, label: string, listed: readonly RefEntry[]): HTMLElement {
  const row = document.createElement('div');
  const closed = branchGroupsClosed.has(kind);

  row.className = 'branch-group';

  const all = tickForAll(listed);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'branch-group-toggle';
  toggle.setAttribute('aria-expanded', closed ? 'false' : 'true');
  toggle.title = closed ? `Show the ${listed.length}` : 'Roll this group up';
  toggle.append(
    span('chevron', closed ? '\u25B8' : '\u25BE'),
    span('branch-group-label', label),
    span('branch-group-count', String(listed.length)),
  );

  toggle.addEventListener('click', () => {
    if (closed) {
      branchGroupsClosed.delete(kind);
    } else {
      branchGroupsClosed.add(kind);
    }

    remember();
    renderBranchMenu();
  });

  row.append(all, toggle);
  return row;
}

/**
 * The tick for everything listed under a heading, a group's or a folder's - see `branchGroupHeader`
 * for why it is what is listed. Neither on nor off when some of it is drawn: clicking from there draws
 * all of it, which is the half of the answer that loses nothing.
 */
function tickForAll(listed: readonly RefEntry[]): HTMLInputElement {
  const drawn = listed.filter((entry) => entry.visible).length;
  const all = document.createElement('input');

  all.type = 'checkbox';
  all.className = 'branch-draw';
  all.checked = drawn === listed.length;
  all.indeterminate = drawn > 0 && drawn < listed.length;
  all.title = all.checked ? `Stop drawing all ${listed.length}` : `Draw all ${listed.length}`;
  all.setAttribute('aria-label', all.title);
  all.addEventListener('change', () => {
    setRefsDrawn(
      listed.filter((entry) => entry.visible === !all.checked).map((entry) => entry.refName),
      all.checked,
    );
  });

  return all;
}

/**
 * A folder in the list: a tick for everything listed inside it, and a label that opens it.
 *
 * Closed until opened, unlike the groups: a folder is there to keep what is in it out of the way until
 * it is asked for - forty Fix_ branches are not the rows anybody came to find. Open whenever the
 * filter has text in it, though, since a name being typed is a name being looked for, wherever it is.
 */
function branchFolderHeader(
  key: string,
  label: string,
  listed: readonly RefEntry[],
  depth: number,
  open: boolean,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'branch-folder';
  row.style.setProperty('--depth', String(depth));

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'branch-folder-toggle';
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.title = open ? 'Close this folder' : `Show the ${listed.length}`;
  toggle.append(
    span('chevron', open ? '\u25BE' : '\u25B8'),
    span('branch-folder-label', label),
    span('branch-group-count', String(listed.length)),
  );

  toggle.addEventListener('click', () => {
    if (open) {
      branchFoldersOpen.delete(key);
    } else {
      branchFoldersOpen.add(key);
    }

    remember();
    renderBranchMenu();
  });

  row.append(tickForAll(listed), toggle);
  return row;
}

function renderBranchMenu(): void {
  const needle = branchFilter.value.trim().toLowerCase();
  const matches = refEntries.filter(
    (entry) => entry.kind !== 'tag' && entry.label.toLowerCase().includes(needle),
  );

  branchRows.replaceChildren();
  branchEmpty.hidden = matches.length > 0;

  /*
   * What is drawn goes first, whatever kind it is.
   *
   * The graph is showing these, and they are the rows you come back to switch off - which on a
   * repository with a hundred and fifty branches means finding three of them. Split by kind they
   * are three needles in two haystacks: tick a remote and it rises to the top of Remote, which is
   * below every local branch there is.
   *
   * Read from `visible` every time it draws, so it is never behind what it is describing. It was
   * held still while the menu was open, so that a ticked row would not move out from under the
   * pointer - and then it said one when two were drawn, which is the one thing this section must
   * never do. The movement it was avoiding is small anyway: the row leaves its group and joins
   * this one above, so everything below it shifts up by a row and down by a row.
   */
  const drawn = matches.filter((entry) => entry.visible);

  if (drawn.length > 0) {
    branchRows.append(branchGroupHeader('drawn', 'Drawn', drawn));

    if (!branchGroupsClosed.has('drawn')) {
      for (const entry of drawn) {
        branchRows.append(branchRow(entry, true));
      }
    }
  }

  // Then the rest, by kind. Local first: it is the half you check out. Remote branches are listed
  // under their own heading rather than mixed in, because `origin/main` and `main` are different
  // things to switch to.
  for (const kind of ['local', 'remote'] as const) {
    const group = matches.filter((entry) => entry.kind === kind && !entry.visible);

    if (group.length === 0) {
      continue;
    }

    branchRows.append(branchGroupHeader(kind, kind === 'local' ? 'Local' : 'Remote', group));

    // Rolled up hides the branches, never the heading: the tick and the count stay reachable, so a
    // collapsed group is still one click from being switched off entirely.
    if (branchGroupsClosed.has(kind)) {
      continue;
    }

    // Folded as the sidebar folds them - see `foldRefs` - with remote branches from one remote read
    // without its name. What is drawn stays above, flat: those are the rows being looked at.
    const remotes = new Set(group.map((entry) => entry.label.split('/')[0] ?? ''));
    const strip = kind === 'remote' && remotes.size === 1 ? `${[...remotes][0] ?? ''}/` : '';
    const names = group.map((entry) => (strip.length > 0 ? entry.label.slice(strip.length) : entry.label));
    const folded = foldRefs(group, (entry) => entry.label, foldingFor(names, folderSetting), strip);

    appendFolded(kind, folded, 0, needle.length > 0);
  }
}

/** Folded entries as rows: a folder's heading, and what is inside it while it is open. */
function appendFolded(
  kind: string,
  nodes: readonly Folded<RefEntry>[],
  depth: number,
  filtering: boolean,
): void {
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      branchRows.append(branchRow(node.item, false, node.label, depth));
      continue;
    }

    const key = `${kind}:${node.path}`;
    const open = filtering || branchFoldersOpen.has(key);

    branchRows.append(branchFolderHeader(key, node.label, leavesOf(node.children), depth, open));

    if (open) {
      appendFolded(kind, node.children, depth + 1, filtering);
    }
  }
}

function leavesOf(nodes: readonly Folded<RefEntry>[]): RefEntry[] {
  return nodes.flatMap((node) => (node.kind === 'leaf' ? [node.item] : leavesOf(node.children)));
}

/**
 * The saved presets, a chip each, and the two ways to make or change them.
 *
 * Above the list rather than in it: a preset is a set of ticks, not a branch, and a row among a
 * hundred and fifty would be found the way a branch is - by looking for it. Save… and Manage… ask
 * the host, which asks in VS Code's own boxes.
 */
function renderPresets(): void {
  const chips = presetEntries.map((preset) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'branch-preset';
    chip.dataset['preset'] = preset.name;
    chip.textContent = preset.name;
    chip.title = `Draw ${preset.name}: ${preset.describes}`;
    return chip;
  });

  const action = (what: 'save' | 'manage', label: string, title: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'branch-preset quiet';
    button.dataset['action'] = what;
    button.textContent = label;
    button.title = title;
    return button;
  };

  branchPresets.replaceChildren(
    ...chips,
    action('save', 'Save…', 'Save the ticks as they are, under a name'),
    ...(presetEntries.length === 0 ? [] : [action('manage', 'Manage…', 'Draw, save or delete a preset')]),
  );
}

function openBranchMenu(): void {
  branchFilter.value = '';
  renderBranchMenu();
  branchList.hidden = false;
  branchButton.setAttribute('aria-expanded', 'true');
  branchFilter.focus();
}

/** What the button says: the branch HEAD is on, or that there is not one. */
function renderBranchButton(): void {
  branchCurrent.textContent = headBranch ?? 'detached';
  branchButton.classList.toggle('detached', headBranch === null);
  /*
   * Written here as well as in the markup, and this is the one the reader sees: the markup's copy
   * only survives until the first ref list arrives. Both said "pick another to check it out" long
   * after the menu stopped doing that.
   */
  branchButton.title =
    headBranch === null
      ? 'HEAD is not on a branch. Tick which branches the graph draws; the box beside this one switches branch.'
      : `On ${headBranch}. Tick which branches the graph draws; the box beside this one switches branch.`;
}

/*
 * The quick switch: its own box, its own list, and one thing per row.
 *
 * Not the dropdown beside it, and this is the only thing here that switches branch. That one
 * answers "which branches should the graph draw", and every part of a row there means the same
 * thing. It did once check out from the name beside each tick, which put the destructive answer to
 * a different question on the larger of two targets a pixel apart - and on the one path that did
 * not stop to ask. This asks, every time.
 */
function jumpMenuOpen(): boolean {
  return !jumpList.hidden;
}

function closeJumpMenu(): void {
  jumpList.hidden = true;
}

/** Which row Return would take, as an index into the branches this can actually switch to. */
let jumpPick = 0;

function pickableJumps(): HTMLButtonElement[] {
  // `Array.from` rather than a spread: the DOM lib here is the one without `DOM.Iterable`, so a
  // NodeList is array-like and not iterable.
  return Array.from(jumpRows.querySelectorAll<HTMLButtonElement>('.jump-name')).filter(
    (name) => !name.disabled,
  );
}

/** Put the mark on the aimed-at row, and keep it in view while the arrows walk past the fold. */
function paintJumpPick(): void {
  const names = pickableJumps();

  if (names.length === 0) {
    jumpPick = 0;
    return;
  }

  jumpPick = ((jumpPick % names.length) + names.length) % names.length;

  names.forEach((name, i) => name.classList.toggle('picked', i === jumpPick));
  names[jumpPick]?.scrollIntoView({ block: 'nearest' });
}

/**
 * Check one out, from the quick-switch box - the one place here that switches branch.
 *
 * The host asks first, because the action says it moves HEAD. Not decided here: this used to send
 * a `confirm` flag and the right-click menu sent none, so the same checkout asked or did not
 * depending on which control you reached for.
 *
 * A remote branch is a different action from a local one: it has to end on a local branch of that
 * name, creating and tracking one when there is none, because checking out the remote branch
 * itself detaches HEAD.
 */
function checkoutRef(entry: RefEntry): void {
  closeJumpMenu();
  closeBranchMenu();
  branchJump.value = '';

  post({
    type: 'runAction',
    id: entry.kind === 'remote' ? 'weft.checkoutRemoteBranch' : 'weft.checkoutBranch',
    target: { kind: 'ref', refName: entry.refName, label: entry.label, refKind: entry.kind },
  });
}

function renderJumpMenu(): void {
  const needle = branchJump.value.trim().toLowerCase();
  const matches = refEntries.filter(
    (entry) => entry.kind !== 'tag' && entry.label.toLowerCase().includes(needle),
  );

  jumpRows.replaceChildren();
  jumpEmpty.hidden = matches.length > 0;

  // Local first: it is the half you check out by name. A remote one is still offered, because
  // "switch to the branch somebody else pushed" is the other half of the same question.
  for (const kind of ['local', 'remote'] as const) {
    const group = matches.filter((entry) => entry.kind === kind);

    if (group.length === 0) {
      continue;
    }

    const heading = document.createElement('div');
    heading.className = 'jump-group';
    heading.textContent = kind === 'local' ? 'Local' : 'Remote';
    jumpRows.append(heading);

    for (const entry of group) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'jump-name';
      row.title = entry.refName;

      row.append(span('jump-label', entry.label));

      /*
       * How long since it moved.
       *
       * The question a list of a hundred and fifty branch names raises and cannot answer is which
       * of them are still alive. Reading it here is the difference between switching to the branch
       * you meant and switching to one that was abandoned in March.
       */
      if (entry.updated > 0) {
        row.append(span('jump-age', describeAge(entry.updated)));
      }

      if (entry.kind === 'local' && entry.label === headBranch) {
        // Listed, so the box can show where you are. Not clickable, because you are there.
        row.disabled = true;
      } else {
        // Asked about first: this row is one Return away from a checkout, and the box above it is
        // a text field - which is a keystroke somebody can arrive at while still typing.
        row.addEventListener('click', () => checkoutRef(entry));
      }

      jumpRows.append(row);
    }
  }

  // After the rows exist, because it measures them.
  paintJumpPick();
}

function openJumpMenu(): void {
  jumpPick = 0;
  renderJumpMenu();
  jumpList.hidden = false;
}

/**
 * Wire it up.
 *
 * The listeners are registered here rather than at module load so that nothing fires before the
 * view has said where messages go - a click that posted into a no-op would look like a dead button.
 */
export function connect(options: {
  post: (message: WebviewMessage) => void;
  remember: () => void;
}): void {
  post = options.post;
  remember = options.remember;

  branchButton.addEventListener('click', () => {
    if (branchMenuOpen()) {
      closeBranchMenu();
    } else {
      openBranchMenu();
    }
  });

  /*
   * Everything, the branch you are on, or nothing.
   *
   * Delegated from the row rather than bound per button, because the three of them never change and
   * one listener is one listener. The host does the work: "nothing" is fourteen hundred ref names
   * the view would have to send, and "the branch you are on" is HEAD, which is the host's to read.
   */
  refPresets.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('.ref-preset') as HTMLElement | null;
    const preset = button?.dataset['preset'];

    if (preset === 'all' || preset === 'none' || preset === 'current') {
      post({ type: 'refsPreset', preset });
    }
  });

  // A chip draws its preset. Save… and Manage… are the host's to ask about.
  branchPresets.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('.branch-preset') as HTMLElement | null;
    const name = button?.dataset['preset'];
    const action = button?.dataset['action'];

    if (name !== undefined) {
      post({ type: 'applyRefsPreset', name });
    } else if (action === 'save') {
      post({ type: 'saveRefsPreset' });
    } else if (action === 'manage') {
      post({ type: 'manageRefsPresets' });
    }
  });

  branchFilter.addEventListener('input', renderBranchMenu);

  branchFilter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Handled here so it closes the menu rather than reaching the document handler, which would
      // read Escape as "clear the selection" and leave the menu open.
      event.stopPropagation();
      closeBranchMenu();
      branchButton.focus();
    }
  });

  // Reaching for the box is the request to see the list.
  branchJump.addEventListener('focus', () => {
    if (!jumpMenuOpen()) {
      openJumpMenu();
    }
  });

  branchJump.addEventListener('input', () => {
    // Back to the top on every keystroke: after narrowing, the best match is the first one, and an
    // aim left where it was points at whichever branch has moved into that position.
    jumpPick = 0;
    jumpList.hidden = false;
    renderJumpMenu();
  });

  branchJump.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Stopped here, or the document handler reads Escape as "drop the selection" and leaves this
      // open behind it.
      event.stopPropagation();
      closeJumpMenu();
      branchJump.value = '';
      branchJump.blur();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Or the caret walks the text instead, which is the one thing the arrows are not for here.
      event.preventDefault();
      jumpPick += event.key === 'ArrowDown' ? 1 : -1;
      paintJumpPick();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      // The same click a mouse would make, so checking out has one path and not two.
      pickableJumps()[jumpPick]?.click();
    }
  });
}

/**
 * The refs moved.
 *
 * Whichever list is open is rebuilt, and only that one: redrawing a closed menu is work nobody
 * asked for, and redrawing an open one is the point - a checkout or a tick lands here as the next
 * list under the reader's cursor.
 */
export function setRefs(
  entries: readonly RefEntry[],
  head: string | null,
  presets: readonly RefsPresetEntry[] = [],
  folders: BranchFolders = 'auto',
): void {
  refEntries = entries;
  headBranch = head;
  presetEntries = presets;
  folderSetting = folders;
  renderPresets();

  renderBranchButton();

  if (branchMenuOpen()) {
    renderBranchMenu();
  }

  if (jumpMenuOpen()) {
    renderJumpMenu();
  }
}

/** Which groups are rolled up, for the view to remember across a reload. */
export function collapsedGroups(): string[] {
  return [...branchGroupsClosed];
}

export function restoreCollapsedGroups(kinds: readonly string[]): void {
  branchGroupsClosed = new Set(kinds);
}

/** Which folders are open, for the view to remember across a reload. */
export function openFolders(): string[] {
  return [...branchFoldersOpen];
}

export function restoreOpenFolders(keys: readonly string[]): void {
  branchFoldersOpen = new Set(keys);
}

/** Whether the dropdown is showing, which decides what Escape means. */
export function listOpen(): boolean {
  return branchMenuOpen();
}

export function closeAll(): void {
  closeBranchMenu();
  closeJumpMenu();
}

/** A click somewhere else closes whichever of the two it was not in. */
export function closeIfOutside(target: Node): void {
  if (branchMenuOpen() && !branchList.contains(target) && !branchButton.contains(target)) {
    closeBranchMenu();
  }

  if (jumpMenuOpen() && !jumpList.contains(target) && target !== branchJump) {
    closeJumpMenu();
  }
}
