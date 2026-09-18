// The exported final draft: prose only, nothing the editor keeps for review.
// Run with: npx tsx src/tests/clean-markdown.test.ts

import { exportFilename, toCleanMarkdown } from '../export/clean-markdown.ts';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  got      ${a}`);
}

const ORIGIN = 'https://docs.example/';

assertEqual(
  toCleanMarkdown(
    '# Title\n\nA <span data-proof="authored" data-by="ai:gemini-live">bold</span> claim by <span data-proof="authored" data-by="human:Dan">Dan</span>.\n\n<!-- PROOF\n{"version":2,"marks":{}}\n-->\n\n<!-- PROOF:END -->\n',
    ORIGIN,
  ),
  '# Title\n\nA bold claim by Dan.\n',
  'authorship spans and the metadata block are gone, the words stay',
);

assertEqual(
  toCleanMarkdown('```mermaid proof:W3sidHlwZSI6==\ngraph TD\n  A --> B\n```\n', ORIGIN),
  '```mermaid\ngraph TD\n  A --> B\n```\n',
  'a diagram keeps its source and loses the provenance on its fence',
);

assertEqual(
  toCleanMarkdown(
    'Keep <span data-proof="suggestion" data-id="s1" data-kind="replace" data-by="ai:gemini-live">the original wording</span> here.<span data-kind="insert" data-id="s2" data-proof="suggestion"> And a sentence nobody accepted.</span>\n',
    ORIGIN,
  ),
  'Keep the original wording here.\n',
  'a pending replacement exports the original; a pending insertion is left out',
);

assertEqual(
  toCleanMarkdown('Intro.\n\n<span data-proof="authored" data-by="ai:gemini-live">![An orange](/generated/0a1b.png)</span>\n\n![Elsewhere](https://cdn.example/x.png)\n', ORIGIN),
  'Intro.\n\n![An orange](https://docs.example/generated/0a1b.png)\n\n![Elsewhere](https://cdn.example/x.png)\n',
  'generated images get a full address; other images are untouched',
);

assertEqual(
  toCleanMarkdown('Body.\n\n<!-- PROOF\n{"marks":{"m1":{"quote":"A[Intake] --> B[Review]","kind":"authored"}}}\n-->\n\n<!-- PROOF:END -->\n', ORIGIN),
  'Body.\n',
  'a Mermaid arrow quoted inside the metadata does not end the block early',
);

assertEqual(toCleanMarkdown('One.  \n\n\n\n\nTwo.\n\n\n', ORIGIN), 'One.\n\nTwo.\n', 'spacing is tidied and the file ends with one newline');

assertEqual(exportFilename('Q3 Platform Update: Draft #2!'), 'q3-platform-update-draft-2.md', 'the title becomes a safe filename');
assertEqual(exportFilename('  '), 'document.md', 'an empty title still gets a name');

console.log('clean-markdown: all assertions passed');
