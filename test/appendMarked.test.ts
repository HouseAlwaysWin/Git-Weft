import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * A stand-in for the two DOM calls this makes, the way `graph.test.ts` stands in for the canvas.
 *
 * Enough of an element to record what was appended and in what order, which is the whole question:
 * plain text, a marked run, plain text, and whether the seams between them land on the right
 * characters. Installed before the module is imported, because `span` reaches for `document` when
 * it is called and the import would otherwise be the only thing in the file that needs a browser.
 */
interface Piece {
  readonly marked: boolean;
  readonly text: string;
}

class Element {
  className = '';
  pieces: Piece[] = [];

  set textContent(text: string) {
    this.pieces = text === '' ? [] : [{ marked: false, text }];
  }

  append(...items: (string | Element)[]): void {
    for (const item of items) {
      this.pieces.push(
        typeof item === 'string'
          ? { marked: false, text: item }
          : { marked: item.className === 'hit', text: item.pieces.map((p) => p.text).join('') },
      );
    }
  }
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (): Element => new Element(),
};

const { appendMarked } = await import('../src/webview/highlight.ts');

/** What the row ends up showing, with the marked runs in brackets. */
function shown(text: string, pattern: RegExp | null): string {
  const target = new Element();

  appendMarked(target as unknown as HTMLElement, text, pattern);

  return target.pieces.map((p) => (p.marked ? `[${p.text}]` : p.text)).join('');
}

test('no pattern is the text, untouched', () => {
  assert.equal(shown('Interleave the lane points', null), 'Interleave the lane points');
});

test('a hit in the middle keeps what is on either side of it', () => {
  assert.equal(shown('Interleave the lane points', /lane/g), 'Interleave the [lane] points');
});

test('a hit at the start has nothing before it', () => {
  assert.equal(shown('lane points', /lane/g), '[lane] points');
});

test('a hit at the end has nothing after it', () => {
  assert.equal(shown('the lane', /lane/g), 'the [lane]');
});

test('every hit is marked, not just the first', () => {
  assert.equal(shown('lane over lane', /lane/g), '[lane] over [lane]');
});

test('the whole string can be one hit', () => {
  assert.equal(shown('lane', /lane/g), '[lane]');
});

/*
 * The pattern comes from the search box and the rows come from git, and the two do not always agree:
 * a JavaScript regex reads git's BRE differently in places, and a `content` hit is in the diff
 * rather than in the subject. The plain text is the honest answer, not an empty row.
 *
 * The `cut === 0` branch that says so is belt-and-braces rather than the thing that makes it true:
 * deleting it leaves this passing, because the trailing append then copies the whole string instead.
 * It is worth keeping as the short path - most rows on screen contain no hit at all - but nothing
 * here is holding it in place, and a reader wondering why it is there deserves to know that.
 */
test('a pattern that matches nothing here leaves the text alone', () => {
  assert.equal(shown('Interleave the lane points', /nothing/g), 'Interleave the lane points');
});

/*
 * A zero-width match advances nothing, so marking it would spin: `matchAll` yields one per position
 * and each would append an empty mark. Skipping them means the text is still whole.
 */
test('a pattern that can match nothing at all does not shred the text', () => {
  assert.equal(shown('lane', /x*/g), 'lane');
  assert.equal(shown('a lane', /(?:)/g), 'a lane');
});

test('case-insensitive marking keeps the row spelled as git spelled it', () => {
  assert.equal(shown('Interleave the Lane points', /lane/gi), 'Interleave the [Lane] points');
});

test('adjacent hits do not lose the boundary between them', () => {
  assert.equal(shown('lanelane', /lane/g), '[lane][lane]');
});

test('an alternation marks each branch where it lands', () => {
  assert.equal(shown('lane and points', /lane|points/g), '[lane] and [points]');
});

/*
 * One pattern is used for every row on screen, so it must not carry anything between them.
 *
 * `lastIndex` is state on a global RegExp and this is where it would leak - except that `matchAll`
 * iterates a copy rather than the object it was given, so the reset at the top of the function is
 * insurance against a future `.exec` rather than the reason this passes. It passes with the reset
 * deleted. Asserted anyway, because it is the property that has to hold whoever changes the
 * iteration next.
 */
test('the same pattern marks the second row as well as the first', () => {
  const pattern = /lane/g;

  assert.equal(shown('the lane here', pattern), 'the [lane] here');
  assert.equal(shown('the lane here', pattern), 'the [lane] here');
  assert.equal(shown('a lane', pattern), 'a [lane]');
});
