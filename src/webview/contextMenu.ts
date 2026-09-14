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

/** Where focus was before a menu took it, to be handed back when the menu goes. */
let returnFocus: HTMLElement | null = null;

/** When the keyboard last asked for a menu, and whether its answer should take focus when it comes. */
let keyboardAt = 0;
let keyboardPending = false;

/**
 * How long after Shift+F10 a `contextmenu` event is its echo. The browser follows the key with an
 * event of its own, which VS Code answers with its own menu, on top of this one.
 */
const KEYBOARD_ECHO_MS = 1000;

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
  return menuEl !== null && menuEl.isConnected;
}

/** Take the menu down, and give focus back to wherever it was taken from. */
export function close(): void {
  const back = returnFocus;

  returnFocus = null;
  dismiss();

  if (back !== null && back.isConnected) {
    back.focus({ preventScroll: true });
  }
}

/** Take the menu down and leave focus alone - for a menu about to be replaced by the next one. */
function dismiss(): void {
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

  // The echo of Shift+F10, landing on a row: the keyboard has asked already.
  if (Date.now() - keyboardAt < KEYBOARD_ECHO_MS) {
    return;
  }

  requestAt(target, event.clientX, event.clientY, false);
}

/**
 * Ask for a target's menu at a point - the pointer's, or beside the row for the keyboard - and, for
 * the keyboard, have the first thing on it that can be chosen take focus when it arrives.
 */
export function requestAt(target: Target, x: number, y: number, keyboard: boolean): void {
  close();

  const active = document.activeElement;

  returnFocus = active instanceof HTMLElement ? active : null;
  keyboardPending = keyboard;
  keyboardAt = keyboard ? Date.now() : 0;
  post({ type: 'requestMenu', target, x, y });
}

export function render(
  target: Target,
  items: readonly MenuItem[],
  x: number,
  y: number,
): void {
  // Replaced rather than closed: focus goes back when this menu goes, not before it has arrived.
  dismiss();

  const local = localItems(target);
  const keyboard = keyboardPending;

  keyboardPending = false;

  if (items.length === 0 && local.length === 0) {
    returnFocus = null;
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

  if (keyboard) {
    choosable()[0]?.focus({ preventScroll: true });
  }
}

/**
 * Put a built menu on screen at the pointer, pulled back inside the window if it would hang off.
 *
 * Exported because the column headers build their own menu and want the same arithmetic - there is
 * one right answer to "where does a menu go" and it should not be written twice.
 */
export function showAt(menu: HTMLElement, x: number, y: number): void {
  if (returnFocus === null) {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement ? active : null;
  }

  /*
   * Every item focusable from script but not from Tab, the greyed-out ones said to be so, and the
   * pointer moving the keyboard's place with it - so the arrows carry on from wherever the pointer is.
   */
  menu.querySelectorAll<HTMLElement>('.menu-item').forEach((item) => {
    item.tabIndex = -1;

    if (item.classList.contains('disabled')) {
      item.setAttribute('aria-disabled', 'true');
      return;
    }

    item.addEventListener('mousemove', () => {
      if (document.activeElement !== item) {
        item.focus({ preventScroll: true });
      }
    });
  });

  document.body.append(menu);
  menuEl = menu;

  const box = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - box.width - 4);
  const top = Math.min(y, window.innerHeight - box.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
}

/** The items the keyboard moves between: every one on the menu that can be chosen. */
function choosable(): HTMLElement[] {
  return menuEl === null ? [] : Array.from(menuEl.querySelectorAll<HTMLElement>('.menu-item:not(.disabled)'));
}

/**
 * A key, while a menu is open. The arrows move between what can be chosen - past what cannot, and
 * round from one end to the other - Home and End go to the ends, Enter or Space chooses, and Escape
 * or Tab closes the menu and hands focus back. true when the key was the menu's; false, with nothing
 * done, when no menu is open.
 */
export function handleKey(event: KeyboardEvent): boolean {
  if (!isOpen()) {
    return false;
  }

  const items = choosable();
  const at = items.findIndex((item) => item === document.activeElement);
  const go = (index: number): void => items[index]?.focus({ preventScroll: true });

  switch (event.key) {
    case 'ArrowDown':
      go(at < 0 ? 0 : (at + 1) % items.length);
      return true;
    case 'ArrowUp':
      go(at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length);
      return true;
    case 'Home':
      go(0);
      return true;
    case 'End':
      go(items.length - 1);
      return true;
    case 'Enter':
    case ' ':
      items[at]?.click();
      return true;
    case 'Escape':
    case 'Tab':
      close();
      return true;
    default:
      return false;
  }
}

// The echo of Shift+F10 - see KEYBOARD_ECHO_MS - wherever it lands that no row or badge answers it.
window.addEventListener('contextmenu', (event) => {
  if (Date.now() - keyboardAt < KEYBOARD_ECHO_MS) {
    event.preventDefault();
  }
});
