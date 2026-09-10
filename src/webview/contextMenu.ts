/**
 * The right-click menu: one element, built from two sources and placed at the pointer.
 *
 * What goes on it is not decided here. The host's half depends on repository state - mid-rebase,
 * already checked out, a dirty tree - that the webview has no view of, so right-click asks and the
 * answer comes back as a message. The view's half depends on what is selected and what is on the
 * row, which is the view's business. This owns the element, the order, the rules between groups and
 * the arithmetic that keeps it inside the window.
 *
 * Apart from the view because that is all it is: given two lists it builds the same menu every
 * time, which is a thing a test can be handed two lists and check.
 */

import type { MenuItem, Target } from '../actions/types.ts';
import type { WebviewMessage } from '../protocol.ts';
import { span } from './dom.ts';

/** A menu entry the view answers itself, grouped like the host's so the rules land in the same places. */
export interface LocalItem {
  readonly label: string;
  readonly group: string;
  readonly run: () => void;
}

let menuEl: HTMLElement | null = null;

/** Where a message goes, and what the view wants on the menu. Both set by `connect`. */
let post: (message: WebviewMessage) => void = () => undefined;
let localItems: (target: Target) => LocalItem[] = () => [];

export function connect(options: {
  post: (message: WebviewMessage) => void;
  localItems: (target: Target) => LocalItem[];
}): void {
  post = options.post;
  localItems = options.localItems;
}

/** Whether a menu is on screen, which decides what Escape means. */
export function isOpen(): boolean {
  return menuEl !== null;
}

export function close(): void {
  menuEl?.remove();
  menuEl = null;
}

/** A click anywhere but on the menu closes it. The element is this module's, so the test is too. */
export function closeIfOutside(target: Node): void {
  if (menuEl !== null && !menuEl.contains(target)) {
    close();
  }
}

/**
 * Right-click asks the host what is on the menu rather than deciding here: availability depends on
 * repository state - mid-rebase, already checked out, a dirty tree - that the webview has no view
 * of. One round trip per right-click is cheap; a menu that offers an action which then fails is not.
 */
export function request(event: MouseEvent, target: Target): void {
  event.preventDefault();
  close();
  post({ type: 'requestMenu', target, x: event.clientX, y: event.clientY });
}

export function render(
  target: Target,
  items: readonly MenuItem[],
  x: number,
  y: number,
): void {
  close();

  const local = localItems(target);

  if (items.length === 0 && local.length === 0) {
    return;
  }

  /*
   * Copying goes to the bottom, everything else the view answers stays on top.
   *
   * Nobody opens a branch's menu to copy its name - they open it to check the branch out, and
   * Checkout being third meant reading past two things to reach the one thing. Comparing is not
   * the same case: it is a real answer to "what do I want to do with this commit", and on a commit
   * it is the first one.
   */
  const leading = local.filter((item) => item.group !== 'copy');
  const trailing = local.filter((item) => item.group === 'copy');

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  /** Whether anything is on the menu yet, so a rule is only ever drawn between two things. */
  let drawn = false;
  let lastGroup: string | null = null;

  const rule = (): void => {
    const line = document.createElement('div');

    line.className = 'menu-separator';
    menu.append(line);
  };

  const appendLocal = (entries: readonly LocalItem[]): void => {
    for (const item of entries) {
      // A rule between groups, and between these and whatever was already on the menu.
      if (drawn && item.group !== lastGroup) {
        rule();
      }

      drawn = true;
      lastGroup = item.group;

      const el = document.createElement('div');

      el.className = 'menu-item';
      el.setAttribute('role', 'menuitem');
      // textContent, like the host's own items: `menu-label` is not a class this stylesheet has.
      el.textContent = item.label;
      el.addEventListener('click', () => {
        close();
        item.run();
      });

      menu.append(el);
    }
  };

  appendLocal(leading);

  let previousGroup: string | null = null;

  for (const item of items) {
    // A rule between groups, so "Delete" never sits flush against "Checkout" and gets hit by
    // someone aiming one row higher.
    if (drawn && item.group !== previousGroup) {
      rule();
    }

    drawn = true;
    previousGroup = item.group;
    lastGroup = item.group;

    const el = document.createElement('div');
    el.className = item.destructive ? 'menu-item destructive' : 'menu-item';
    el.setAttribute('role', 'menuitem');
    el.textContent = item.label;

    if (item.disabledReason === null) {
      el.addEventListener('click', () => {
        close();
        post({ type: 'runAction', id: item.id, target });
      });
    } else {
      // Greyed out with the reason attached, rather than hidden: an action that vanishes leaves the
      // user wondering whether they misremembered it.
      el.classList.add('disabled');
      el.append(span('menu-reason', item.disabledReason));
    }

    menu.append(el);
  }

  appendLocal(trailing);

  showAt(menu, x, y);
}

/**
 * Put a built menu on screen at the pointer, pulled back inside the window if it would hang off.
 *
 * Exported because the column headers build their own menu and want the same arithmetic - there is
 * one right answer to "where does a menu go" and it should not be written twice.
 */
export function showAt(menu: HTMLElement, x: number, y: number): void {
  document.body.append(menu);
  menuEl = menu;

  const box = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - box.width - 4);
  const top = Math.min(y, window.innerHeight - box.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
}
