// The copy kept before a document collapses.
// Run with: npx tsx src/tests/projection-backup.test.ts

import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'proof-backup-'));
process.env.DATABASE_PATH = path.join(dataDir, 'test.db');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  got      ${a}`);
}

async function run(): Promise<void> {
  const { createDocument } = await import('../../server/db.ts');
  const { backupBeforeCollapse, getBackupDir } = await import('../../server/projection-backup.ts');

  const full = `# Skill\n\n${'A rule that took a while to write. '.repeat(60)}\n`;
  createDocument('longdoc', full, {}, 'Skill');
  createDocument('shortdoc', '# Note\n\nTiny.\n', {}, 'Note');

  assertEqual(backupBeforeCollapse('longdoc', full.slice(0, Math.floor(full.length / 2))), null, 'an ordinary edit, even a big cut, keeps no copy');
  assertEqual(existsSync(getBackupDir()), false, 'and writes nothing');

  const file = backupBeforeCollapse('longdoc', '# Skill\n');
  assertEqual(typeof file, 'string', 'a collapse to a fraction of the text keeps a copy');
  assertEqual(path.dirname(path.dirname(file!)), dataDir, 'beside the database, on the volume');
  assertEqual(readFileSync(file!, 'utf8'), full, 'with the whole previous text');

  assertEqual(backupBeforeCollapse('shortdoc', ''), null, 'a note too small to matter is not kept');
  assertEqual(backupBeforeCollapse('missing', ''), null, 'an unknown document is not an error');
  assertEqual(readdirSync(getBackupDir()).length, 1, 'one file in all');
  console.log('projection-backup: all assertions passed');
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
