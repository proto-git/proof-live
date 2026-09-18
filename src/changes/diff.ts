// Before/after comparison of two Markdown documents, for the "Changes" view.
// Blocks (paragraphs, headings, list items, fenced code) are aligned first; a
// block that changed is then compared word by word. Pure functions, no DOM.

export type DiffOp = 'same' | 'removed' | 'added';

export interface WordPart {
  op: DiffOp;
  text: string;
}

export type BlockRow =
  | { kind: 'same'; text: string }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string }
  | { kind: 'changed'; before: WordPart[]; after: WordPart[] };

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
}

// Longest common subsequence over any comparable items, as a list of operations.
function lcsOps<T>(a: T[], b: T[], equal: (x: T, y: T) => boolean): Array<{ op: DiffOp; a?: T; b?: T }> {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = equal(a[i], b[j])
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: Array<{ op: DiffOp; a?: T; b?: T }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (equal(a[i], b[j])) ops.push({ op: 'same', a: a[i++], b: b[j++] });
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) ops.push({ op: 'removed', a: a[i++] });
    else ops.push({ op: 'added', b: b[j++] });
  }
  while (i < a.length) ops.push({ op: 'removed', a: a[i++] });
  while (j < b.length) ops.push({ op: 'added', b: b[j++] });
  return ops;
}

/**
 * Editor snapshots carry provenance as inline `<span data-proof=...>` wrappers and a
 * trailing `<!-- PROOF {...} -->` metadata comment; compare the prose only.
 */
export function stripProofSpans(markdown: string): string {
  return markdown
    .replace(/<!--\s*PROOF\b[\s\S]*?-->/g, '')
    .replace(/^(\s*(?:```+|~~~+)\S*) proof:\S+$/gm, '$1')
    .replace(/<span\b[^>]*\bdata-proof=[^>]*>/g, '')
    .replace(/<\/span>/g, '');
}

/** Split Markdown into blocks: blank-line separated, fenced code kept whole, list items split. */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      current.push(line);
      if (fenceMatch && fenceMatch[1].startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*([*+-]|\d+[.)])\s+/.test(line) || /^#{1,6}\s/.test(line)) flush();
    current.push(line);
    if (/^#{1,6}\s/.test(line)) flush();
  }
  flush();
  return blocks;
}

function words(text: string): string[] {
  return text.match(/\s+|[^\s\w]|\w+/g) ?? [];
}

function mergeParts(parts: WordPart[]): WordPart[] {
  // Whitespace between two changed words reads as part of the change, not as a gap in it.
  parts = parts.map((part, index) => {
    const prev = parts[index - 1];
    const next = parts[index + 1];
    const bridges = part.op === 'same' && !part.text.trim() && prev && next && prev.op !== 'same' && next.op === prev.op;
    return bridges ? { op: prev.op, text: part.text } : part;
  });
  const merged: WordPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last.op === part.op) last.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
}

export function diffWords(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
  const ops = lcsOps(words(before), words(after), (x, y) => x === y);
  const left: WordPart[] = [];
  const right: WordPart[] = [];
  for (const item of ops) {
    if (item.op === 'same') {
      left.push({ op: 'same', text: item.a! });
      right.push({ op: 'same', text: item.b! });
    } else if (item.op === 'removed') left.push({ op: 'removed', text: item.a! });
    else right.push({ op: 'added', text: item.b! });
  }
  return { before: mergeParts(left), after: mergeParts(right) };
}

// Two blocks are "the same block, edited" when enough of their words survive.
function similarity(a: string, b: string): number {
  const aw = words(a).filter(w => w.trim());
  const bw = words(b).filter(w => w.trim());
  if (!aw.length || !bw.length) return 0;
  const common = lcsOps(aw, bw, (x, y) => x === y).filter(item => item.op === 'same').length;
  return (2 * common) / (aw.length + bw.length);
}

export function diffMarkdown(before: string, after: string): BlockRow[] {
  const ops = lcsOps(splitBlocks(before), splitBlocks(after), (x, y) => x.trim() === y.trim());
  const rows: BlockRow[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    // Pair each removed block with the first sufficiently similar added block.
    const unpairedAdded = [...added];
    for (const old of removed) {
      const index = unpairedAdded.findIndex(candidate => similarity(old, candidate) >= 0.4);
      if (index === -1) {
        rows.push({ kind: 'removed', text: old });
        continue;
      }
      // Added blocks that come before the match are genuinely new.
      for (const fresh of unpairedAdded.splice(0, index)) rows.push({ kind: 'added', text: fresh });
      rows.push({ kind: 'changed', ...diffWords(old, unpairedAdded.shift()!) });
    }
    for (const fresh of unpairedAdded) rows.push({ kind: 'added', text: fresh });
    removed = [];
    added = [];
  };
  for (const item of ops) {
    if (item.op === 'same') {
      flush();
      rows.push({ kind: 'same', text: item.b! });
    } else if (item.op === 'removed') removed.push(item.a!);
    else added.push(item.b!);
  }
  flush();
  return rows;
}

export function summarize(rows: BlockRow[]): DiffSummary {
  const summary: DiffSummary = { added: 0, removed: 0, changed: 0 };
  for (const row of rows) if (row.kind !== 'same') summary[row.kind] += 1;
  return summary;
}
