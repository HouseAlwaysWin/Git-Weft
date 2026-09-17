/*
 * The UI probe's script for the interactive rebase editor: replays what the host sends it, works the
 * page the way a person does, and records what it drew and what it sent back.
 *
 * Injected by scripts/ui-probe.mjs, after rebase.js, into a copy of dist/rebase-preview.html - which
 * carries a todo built by the same two functions the editor builds one with.
 * Sections are headed `=== rebase: name ===`, so they sit beside the other two pages' in one recording.
 *
 * It writes facts down and judges nothing. What has to hold is in the runner, where a mistake in this
 * script cannot pass a check by leaving it out.
 */
(async () => {
  const parts = [];
  const section = (name, lines) => parts.push('=== rebase: ' + name + ' ===\n' + [].concat(lines).join('\n'));

  try {
    const settle = (ms) => new Promise((done) => setTimeout(done, ms));
    const post = (message) => window.postMessage(message, '*');
    const one = (selector) => document.querySelector(selector);
    const sent = () => window.__sent || [];
    const since = (count) => sent().slice(count).map((message) => JSON.stringify(message)).join('\n');
    const rows = () => [...document.querySelectorAll('#rebase-rows .rebase-row')];
    const at = (row, selector) => row.querySelector(selector);
    const todo = window.__todo || { rows: [] };

    // The page asks for the list as it loads, and draws what comes back.
    await settle(250);

    section('the list as drawn', [
      'onto: ' + one('#rebase-onto').textContent,
      'summary: ' + one('#rebase-summary').textContent,
      'problem: hidden=' + one('#rebase-problem').hidden,
      ...rows().map((row) =>
        [
          'action=' + at(row, '.rebase-action').value,
          'class=' + JSON.stringify(row.className),
          'sha=' + at(row, '.rebase-sha').textContent,
          'subject=' + JSON.stringify(at(row, '.rebase-subject').textContent),
          'author=' + JSON.stringify(at(row, '.rebase-author').textContent),
        ].join(' '),
      ),
    ]);

    // What a row can be made into, and what each of those says it does - the whole of the help there is.
    section(
      'what a row can be',
      [...at(rows()[0], '.rebase-action').options].map((option) => option.value + ': ' + option.textContent),
    );

    /*
     * The made-up last row, whose subject is markup. Recorded three ways because only all three tell the
     * difference between text that looks like markup and markup that was made into elements.
     */
    const subject = at(rows().at(-1), '.rebase-subject');

    section('a subject with markup in it', [
      'text: ' + JSON.stringify(subject.textContent),
      'elements: ' + subject.children.length,
      'html: ' + JSON.stringify(subject.innerHTML),
    ]);

    // An action changed, which the page sends by the commit's place in the list rather than by its sha.
    let before = sent().length;
    const action = at(rows()[2], '.rebase-action');

    action.value = 'fixup';
    action.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(150);
    section('changing an action sends', since(before));

    // The two buttons on each row.
    before = sent().length;
    at(rows()[1], '.rebase-down').click();
    at(rows()[3], '.rebase-up').click();
    await settle(150);
    section('the move buttons send', since(before));

    /*
     * Alt and an arrow move the commit the keyboard is on - the gesture from moving a line in the editor
     * itself - and the same arrow without Alt belongs to the list, so it must send nothing.
     */
    before = sent().length;
    const onFive = at(rows()[4], '.rebase-action');

    onFive.focus();
    onFive.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    onFive.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle(150);
    section('the keyboard sends', since(before));

    /*
     * And the answer to that move: the host writes the file and sends the whole list back, so the page
     * that had the keyboard is drawn again from scratch. The keyboard has to come back to the commit that
     * moved, at the place it moved to - otherwise moving one commit three times is three trips back to it.
     */
    const moved = todo.rows.slice();
    const [lifted] = moved.splice(4, 1);

    moved.splice(3, 0, lifted);
    post({ type: 'todo', rows: moved, summary: todo.summary, onto: todo.onto });
    await settle(250);

    const holding = rows().findIndex((row) => row.contains(document.activeElement));

    section('after the list came back', [
      'focus row: ' + holding,
      'focus class: ' + (document.activeElement ? document.activeElement.className : '(nothing)'),
      'sha there: ' + (rows()[3] ? at(rows()[3], '.rebase-sha').textContent : '(no row)'),
      'sha that moved: ' + (lifted ? lifted.sha : '(none)'),
    ]);

    // A write that failed, which is said beside the buttons rather than in a notification behind the editor.
    post({ type: 'failed', message: 'That change could not be written to the rebase file, so nothing has changed.' });
    await settle(200);
    section('a write that failed', [
      'problem: hidden=' + one('#rebase-problem').hidden,
      'says: ' + JSON.stringify(one('#rebase-problem').textContent),
    ]);

    post({ type: 'todo', rows: todo.rows, summary: todo.summary, onto: todo.onto });
    await settle(200);
    section('and the list after it', 'problem: hidden=' + one('#rebase-problem').hidden);

    // The two buttons the whole editor is for.
    before = sent().length;
    one('#rebase-start').click();
    one('#rebase-abort').click();
    await settle(150);
    section('the buttons send', since(before));
  } catch (error) {
    // Written rather than lost: a probe that dies partway leaves a recording that looks deliberate.
    parts.push('=== rebase: probe failed ===\n' + String((error && error.stack) || error));
  }

  const thrown = window.__thrown || [];
  parts.push('=== rebase: thrown ===\n' + (thrown.length === 0 ? '(nothing)' : thrown.join('\n')));

  const out = document.createElement('pre');
  out.id = 'ui-probe';
  out.textContent = parts.join('\n\n');
  document.body.appendChild(out);
})();
