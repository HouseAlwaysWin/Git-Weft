/**
 * The interactive rebase editor's page.
 *
 * It holds nothing. Every change - an action, a move - is sent to the host, which writes the todo file
 * and sends the whole list back; the page draws what it is given. The file is the rebase, so the file
 * is the one place the state can live, and a page that kept its own would be a second opinion about
 * what is about to happen to somebody's history.
 *
 * Subjects and names come from other people's keyboards, so they only ever go in as text.
 */

import type { RebaseHostMessage, RebaseRow, RebaseWebviewMessage } from '../protocol.ts';

interface VsCodeApi {
  postMessage(message: RebaseWebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** What a rebase can do with a commit, in the order the menu offers them. */
const ACTIONS: readonly RebaseRow['action'][] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** What each one does, said once in the menu rather than in a page of help nobody reads. */
const MEANS: Readonly<Record<RebaseRow['action'], string>> = {
  pick: 'keep it as it is',
  reword: 'keep it, and change the message',
  edit: 'stop here, so it can be amended',
  squash: 'join it to the one above, keeping both messages',
  fixup: 'join it to the one above, keeping the message above',
  drop: 'throw it away',
};

function element<T extends Element = HTMLElement>(id: string): T {
  const found: Element | null = document.getElementById(id);

  if (found === null) {
    throw new Error(`the rebase editor has no #${id}`);
  }

  return found as T;
}

const ontoEl = element('rebase-onto');
const rowsEl = element('rebase-rows');
const summaryEl = element('rebase-summary');
const startEl = element<HTMLButtonElement>('rebase-start');
const abortEl = element<HTMLButtonElement>('rebase-abort');

/**
 * Which control had the keyboard when the list was last drawn.
 *
 * Every change redraws the list from the file, so without this a commit moved with the keyboard would
 * take the keyboard away from itself, and moving one three places would be three trips back to it.
 */
let focused: { readonly at: number; readonly what: string } | null = null;

function remember(at: number, what: string): void {
  focused = { at, what };
}

function draw(message: RebaseHostMessage): void {
  ontoEl.textContent = message.onto;
  summaryEl.textContent = message.summary;

  rowsEl.replaceChildren(
    ...message.rows.map((row, at) => {
      const item = document.createElement('li');
      item.className = `rebase-row rebase-${row.action}`;

      const action = document.createElement('select');
      action.className = 'rebase-action';
      action.setAttribute('aria-label', `What to do with ${row.sha}`);
      action.replaceChildren(
        ...ACTIONS.map((name) => {
          const option = document.createElement('option');

          option.value = name;
          option.textContent = `${name} - ${MEANS[name]}`;
          option.selected = name === row.action;
          return option;
        }),
      );
      action.addEventListener('change', () => {
        remember(at, 'action');
        vscode.postMessage({ type: 'action', at, action: action.value as RebaseRow['action'] });
      });

      const sha = document.createElement('span');
      sha.className = 'rebase-sha';
      sha.textContent = row.sha;

      const subject = document.createElement('span');
      subject.className = 'rebase-subject';
      subject.textContent = row.subject;

      const author = document.createElement('span');
      author.className = 'rebase-author';
      author.textContent = row.author;

      const up = move(at, -1, '↑', `Move ${row.sha} up`);
      const down = move(at, 1, '↓', `Move ${row.sha} down`);

      item.append(action, sha, subject, author, up, down);
      return item;
    }),
  );

  // The keyboard back where it was, on the row that moved rather than on the place it left.
  const back = focused;

  if (back !== null) {
    const row = rowsEl.children[back.at];
    const control = row?.querySelector<HTMLElement>(`.rebase-${back.what}`);

    control?.focus();
  }
}

/** One of the two buttons that move a commit. */
function move(at: number, by: number, glyph: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = by < 0 ? 'rebase-move rebase-up' : 'rebase-move rebase-down';
  button.textContent = glyph;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', () => {
    remember(at + by, by < 0 ? 'up' : 'down');
    vscode.postMessage({ type: 'move', at, by });
  });

  return button;
}

window.addEventListener('message', (event: MessageEvent<RebaseHostMessage>) => {
  if (event.data.type === 'todo') {
    draw(event.data);
  }
});

/*
 * Alt and an arrow move the commit the keyboard is on, which is the gesture people know from moving a
 * line in the editor itself. Without a modifier the arrows belong to the list.
 */
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
    return;
  }

  const row = (event.target as HTMLElement | null)?.closest('.rebase-row');
  const at = row === null || row === undefined ? -1 : Array.from(rowsEl.children).indexOf(row);

  if (at >= 0) {
    const by = event.key === 'ArrowUp' ? -1 : 1;

    event.preventDefault();
    remember(at + by, 'action');
    vscode.postMessage({ type: 'move', at, by });
  }
});

startEl.addEventListener('click', () => vscode.postMessage({ type: 'start' }));
abortEl.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));

vscode.postMessage({ type: 'ready' });
