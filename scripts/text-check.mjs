/**
 * Every tracked text file is UTF-8, with no byte-order mark and no control character but a tab, a
 * carriage return or a newline.
 *
 * A NUL once went into blameAnnotations.ts as the character itself rather than as its escape, and
 * nothing that runs the code minded - the string is the same either way. What minded was everything
 * that reads the file: grep called it binary and stopped looking, and past git's first eight thousand
 * bytes a diff of it is a diff of a binary file. A byte-order mark is the other thing a file picks up
 * on its way through the wrong tool, and no editor shows one.
 *
 *   node scripts/text-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TEXT = /\.(ts|mjs|js|json|md|css|html|yml|yaml|txt)$/;
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => TEXT.test(file));

const problems = [];

for (const file of files) {
  const bytes = readFileSync(file);

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push(`${file} starts with a byte-order mark`);
  }

  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    problems.push(`${file} is not UTF-8`);
    continue;
  }

  text.split('\n').forEach((line, index) => {
    const control = [...line].find((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 && code !== 0x09 && code !== 0x0d;
    });

    if (control !== undefined) {
      const code = (control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      problems.push(`${file}:${index + 1} holds a control character, U+${code}`);
    }
  });
}

console.log(`text files     : ${files.length} read`);

if (problems.length > 0) {
  console.log('');
  console.log('FAILED:');

  for (const problem of problems) {
    console.log(`  - ${problem}`);
  }

  process.exit(1);
}

console.log('OK - every text file is UTF-8, with nothing in it that an editor would not show.');
