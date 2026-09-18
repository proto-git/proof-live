// A last copy before a collapse. The collab engine lets the browser's live copy
// win over the stored document, and only warns when that copy is suddenly a
// fraction of the size. When that happens the text being replaced is written
// beside the database first, so a wiped document can always be brought back.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocumentBySlug } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLAPSE_RATIO = 0.2;
const MIN_CHARS_WORTH_KEEPING = 400;

export function getBackupDir(): string {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'proof-share.db');
  return path.join(path.dirname(dbPath), 'collapsed-documents');
}

/** Returns the file written, or null when the change is not a collapse. Never throws. */
export function backupBeforeCollapse(slug: string, nextMarkdown: string): string | null {
  try {
    const current = getDocumentBySlug(slug)?.markdown ?? '';
    if (current.length < MIN_CHARS_WORTH_KEEPING || nextMarkdown.length >= current.length * COLLAPSE_RATIO) return null;
    const file = path.join(getBackupDir(), `${slug.replace(/[^\w-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    mkdirSync(getBackupDir(), { recursive: true });
    writeFileSync(file, current, 'utf8');
    console.warn('[collab] document collapsed; previous text kept', { slug, previousChars: current.length, nextChars: nextMarkdown.length, file });
    return file;
  } catch (error) {
    console.error('[collab] could not keep a copy before a collapse', { slug, error });
    return null;
  }
}
