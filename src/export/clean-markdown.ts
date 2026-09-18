// The final draft: the document as plain Markdown, without anything the editor
// keeps for review. What the author has not accepted is not part of the draft.

import { stripProofSpans } from '../changes/diff';

// A pending insertion lives in the text, wrapped in its suggestion span. It has
// not been accepted, so it goes. (Pending replacements and deletions only wrap
// the original text, which stays.)
const PENDING_INSERT = /<span\b(?=[^>]*\bdata-proof="suggestion")(?=[^>]*\bdata-kind="insert")[^>]*>[\s\S]*?<\/span>/g;

export function toCleanMarkdown(snapshot: string, origin: string): string {
  const base = origin.replace(/\/+$/, '');
  const markdown = stripProofSpans(snapshot.replace(PENDING_INSERT, ''))
    // Images the agent generated are served by this site; a downloaded file needs the full address.
    .replace(/(!\[[^\]]*\]\()(\/generated\/[^)\s]+)/g, (_match, open: string, path: string) => `${open}${base}${path}`)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${markdown}\n`;
}

export function exportFilename(title: string | null | undefined): string {
  const name = (title ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80);
  return `${name || 'document'}.md`;
}

export function downloadMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
