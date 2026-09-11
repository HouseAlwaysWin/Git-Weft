/**
 * Does every doc comment sit on what it describes?
 *
 * Moving code is how a comment gets stranded: the cut starts at a declaration, the comment above it
 * stays behind, and it ends up on top of whatever came next - usually another comment, which is
 * the one sign of it a machine can see. Two comments in a row with no code between them means the
 * first one describes something that is not there. It happened on almost every cut the view was
 * split into, and eleven had piled up before anything looked.
 *
 * So: a block comment whose next non-blank line opens another block comment is reported, unless it
 * is listed below as deliberately a heading for a section rather than a description of one thing.
 *
 *   node scripts/comment-check.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const src = join(root, 'src');

/*
 * Comments that head a section and are followed by the first item's own comment. Each is named by
 * file and its first line, not by line number, so an edit above it does not silently change which
 * comment is excused.
 */
const SECTION_HEADINGS = new Set([]);

const files = readdirSync(src, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(ts|css)$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));

const stranded = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);

  /*
   * A file's own header is followed by its first declaration's comment - two comments in a row by
   * design, and in half the files here. Excused by position rather than by listing them, so a new
   * file needs nothing added below.
   */
  const header = lines.findIndex((line) => line.trim() !== '');

  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].trim();

    // Doc comments in TypeScript; any block comment in CSS, which has no other kind.
    const isComment = file.endsWith('.css') ? opening.startsWith('/*') : opening.startsWith('/**');

    if (!isComment) {
      continue;
    }

    let end = i;

    while (end < lines.length && !lines[end].includes('*/')) {
      end++;
    }

    let next = end + 1;

    while (next < lines.length && lines[next].trim() === '') {
      next++;
    }

    if (i !== header && next < lines.length && lines[next].trim().startsWith('/*')) {
      const name = `${relative(root, file).replaceAll('\\', '/')}: ${opening}`;

      if (!SECTION_HEADINGS.has(name)) {
        stranded.push({ at: `${relative(root, file).replaceAll('\\', '/')}:${i + 1}`, first: opening, next: next + 1 });
      }
    }

    i = end;
  }
}

console.log(`doc comments   : ${stranded.length === 0 ? 'every one on its code' : `${stranded.length} STRANDED`}`);

for (const { at, first, next } of stranded) {
  console.error(`  ! ${at}  ${first.slice(0, 70)}  (another comment starts at line ${next})`);
}

process.exit(stranded.length === 0 ? 0 : 1);
