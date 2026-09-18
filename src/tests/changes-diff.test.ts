// Before/after diff behind the "Changes" view.
// Run with: npx tsx src/tests/changes-diff.test.ts

import { diffMarkdown, diffWords, splitBlocks, stripProofSpans, summarize } from '../changes/diff.ts';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  got      ${a}`);
}

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ok ${name}`);
}

test('splits paragraphs, headings, list items, and keeps fenced code whole', () => {
  const md = '# Title\nIntro line\nstill intro\n\n* one\n* two\n\n```mermaid\ngraph TD\n\n  A --> B\n```\nTail';
  assertEqual(splitBlocks(md), ['# Title', 'Intro line\nstill intro', '* one', '* two', '```mermaid\ngraph TD\n\n  A --> B\n```', 'Tail'], 'blocks');
});

test('strips provenance spans but keeps their text', () => {
  assertEqual(
    stripProofSpans('A <span data-proof="authored" data-by="ai:gemini-live">bold</span> claim'),
    'A bold claim',
    'spans',
  );
  assertEqual(stripProofSpans('Body\n\n<!-- PROOF\n{ "version": 2 }\n-->\n').trim(), 'Body', 'metadata footer');
});

test('an identical document has no changes', () => {
  const rows = diffMarkdown('# T\n\nBody', '# T\n\nBody');
  assertEqual(rows.map(r => r.kind), ['same', 'same'], 'kinds');
  assertEqual(summarize(rows), { added: 0, removed: 0, changed: 0 }, 'summary');
});

test('a reworded paragraph is one changed row with word-level parts', () => {
  const rows = diffMarkdown('# T\n\nThe agent will rewrite a little here.', '# T\n\nThe agent will rewrite with conviction here.');
  assertEqual(rows.map(r => r.kind), ['same', 'changed'], 'kinds');
  const row = rows[1];
  if (row.kind !== 'changed') throw new Error('expected changed');
  assertEqual(row.before.filter(p => p.op === 'removed').map(p => p.text), ['a little'], 'removed words');
  assertEqual(row.after.filter(p => p.op === 'added').map(p => p.text), ['with conviction'], 'added words');
});

test('a new paragraph between two others is added, neighbours stay the same', () => {
  const rows = diffMarkdown('One.\n\nThree.', 'One.\n\nTwo is new.\n\nThree.');
  assertEqual(rows.map(r => r.kind), ['same', 'added', 'same'], 'kinds');
});

test('a deleted paragraph is removed', () => {
  const rows = diffMarkdown('One.\n\nTwo goes away.\n\nThree.', 'One.\n\nThree.');
  assertEqual(rows.map(r => r.kind), ['same', 'removed', 'same'], 'kinds');
});

test('an unrelated replacement is a removal plus an addition, not a word soup', () => {
  const rows = diffMarkdown('Quarterly revenue grew in every region.', '```mermaid\ngraph TD\n  A --> B\n```');
  assertEqual(rows.map(r => r.kind), ['removed', 'added'], 'kinds');
});

test('a new block ahead of an edited one keeps its own row', () => {
  const rows = diffMarkdown('The plan ships on Friday morning.', 'Brand new opener.\n\nThe plan ships on Monday morning.');
  assertEqual(rows.map(r => r.kind), ['added', 'changed'], 'kinds');
});

test('word diff keeps punctuation and whitespace intact', () => {
  const { before, after } = diffWords('Hello, world.', 'Hello, brave world.');
  assertEqual(before.map(p => p.text).join(''), 'Hello, world.', 'before text');
  assertEqual(after.map(p => p.text).join(''), 'Hello, brave world.', 'after text');
});

console.log(`changes-diff: ${passed} passed`);
