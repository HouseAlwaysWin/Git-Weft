/** The one-liners that would otherwise be written out four times over. */

/** A `<span class="...">text</span>`, which is most of what the menus and rows are made of. */
export function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');

  el.className = className;
  el.textContent = text;

  return el;
}
