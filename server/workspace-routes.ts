// A shared workspace: documents created or imported through it are listed in the
// editor's sidebar, and anyone who can reach the site can open and add to them.
//
// That is deliberately the opposite of how documents are normally shared (one
// unguessable link each), so it is off unless PROOF_PUBLIC_WORKSPACE=1, and it
// never includes documents that were shared by link. It fits a demo or an
// internal deployment behind its own access control. A deployment with real
// users needs real accounts in front of these routes instead.

import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';
import { ensureCanonicalYjsBaselineForDocument, stripEphemeralCollabSpans } from './collab.js';
import { createDocument, createDocumentAccessToken, getDocumentBySlug, listActiveDocuments } from './db.js';
import { createRateLimiter } from './rate-limiter.js';
import { generateSlug } from './slug.js';
import { refreshSnapshotForSlug } from './snapshot.js';

const MAX_TITLE_CHARS = 200;
const MAX_MARKDOWN_CHARS = 400_000;
const MAX_LISTED_DOCUMENTS = 500;
// Membership: a document is in the workspace because it was created through it.
const WORKSPACE_OWNER_ID = 'workspace';

export function isPublicWorkspaceEnabled(): boolean {
  const value = (process.env.PROOF_PUBLIC_WORKSPACE || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function clientKey(req: Request): string {
  const trustProxy = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
  if (trustProxy === '1' || trustProxy === 'true') {
    const first = req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Creating documents and minting edit links both write to the database.
const writeRateLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 60, keyFn: clientKey });

// Review metadata (suggestion and authorship spans, the trailing PROOF block) is
// for the editor. Anything reading a document as text wants the prose.
function toPlainMarkdown(markdown: string): string {
  return markdown
    .replace(/<!--\s*PROOF[\s\S]*$/, '')
    .replace(/<span data-proof="[^"]*"[^>]*>([\s\S]*?)<\/span>/g, '$1')
    .trimEnd();
}

function titleFromMarkdown(markdown: string): string | null {
  const heading = markdown.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  return heading ? heading[1].trim() : null;
}

function describe(row: { slug: string; title: string | null; markdown: string; updated_at: string; created_at: string }) {
  return {
    slug: row.slug,
    title: (row.title || '').trim() || titleFromMarkdown(row.markdown) || 'Untitled',
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function listWorkspaceDocuments() {
  return listActiveDocuments().filter((doc) => doc.owner_id === WORKSPACE_OWNER_ID);
}

function getWorkspaceDocument(slug: string) {
  const doc = getDocumentBySlug(slug);
  return doc && doc.share_state === 'ACTIVE' && doc.owner_id === WORKSPACE_OWNER_ID ? doc : null;
}

export const workspaceRoutes = Router();

workspaceRoutes.get('/workspace/status', (_req: Request, res: Response) => {
  res.json({ enabled: isPublicWorkspaceEnabled() });
});

workspaceRoutes.use('/workspace', (_req: Request, res: Response, next) => {
  if (isPublicWorkspaceEnabled()) {
    next();
    return;
  }
  res.status(404).json({ error: 'The shared workspace is not enabled on this server', code: 'WORKSPACE_DISABLED' });
});

workspaceRoutes.get('/workspace/documents', (_req: Request, res: Response) => {
  const documents = listWorkspaceDocuments()
    .map(describe)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_LISTED_DOCUMENTS);
  res.json({ documents });
});

workspaceRoutes.post('/workspace/documents', writeRateLimiter, async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const rawTitle = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_CHARS) : '';
  const rawMarkdown = typeof body.markdown === 'string' ? body.markdown : '';
  if (rawMarkdown.length > MAX_MARKDOWN_CHARS) {
    res.status(413).json({ error: 'That document is too large to import', code: 'DOCUMENT_TOO_LARGE' });
    return;
  }

  const title = rawTitle || titleFromMarkdown(rawMarkdown) || 'Untitled';
  // An empty document has nothing for the collab baseline to anchor on.
  const markdown = stripEphemeralCollabSpans(rawMarkdown).trim() ? stripEphemeralCollabSpans(rawMarkdown) : `# ${title}\n`;

  try {
    const slug = generateSlug();
    const doc = createDocument(slug, markdown, canonicalizeStoredMarks({}), title, WORKSPACE_OWNER_ID, randomUUID());
    await ensureCanonicalYjsBaselineForDocument(slug);
    refreshSnapshotForSlug(slug);
    const access = createDocumentAccessToken(slug, 'editor');
    res.status(201).json({
      document: describe(doc),
      url: `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(access.secret)}`,
    });
  } catch (error) {
    console.error('[workspace] failed to create document', error);
    res.status(500).json({ error: 'Could not create the document', code: 'WORKSPACE_CREATE_FAILED' });
  }
});

// A document's edit link is minted when someone opens it, not when it is listed,
// so browsing the sidebar does not fill the database with unused tokens.
workspaceRoutes.post('/workspace/documents/:slug/open', writeRateLimiter, (req: Request, res: Response) => {
  const doc = getWorkspaceDocument(req.params.slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found', code: 'NOT_FOUND' });
    return;
  }
  const access = createDocumentAccessToken(doc.slug, 'editor');
  res.json({ url: `/d/${encodeURIComponent(doc.slug)}?token=${encodeURIComponent(access.secret)}` });
});

workspaceRoutes.get('/workspace/documents/:slug/content', (req: Request, res: Response) => {
  const doc = getWorkspaceDocument(req.params.slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found', code: 'NOT_FOUND' });
    return;
  }
  res.json({ ...describe(doc), markdown: toPlainMarkdown(doc.markdown) });
});

const WELCOME_MARKDOWN = `# Welcome

This is a shared workspace. Its documents are listed in the sidebar on the left.

Use **New** to start a document, or **Import** to bring in Markdown files. Press **Talk to edit** to work on the open document by voice.
`;

// One address to hand out: it lands on the most recently edited document, or on
// a fresh welcome document when the workspace is empty.
export async function handleWorkspaceEntry(_req: Request, res: Response): Promise<void> {
  if (!isPublicWorkspaceEnabled()) {
    res.status(404).type('text').send('The shared workspace is not enabled on this server.');
    return;
  }
  try {
    const latest = listWorkspaceDocuments().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
    let slug = latest?.slug;
    if (!slug) {
      slug = generateSlug();
      createDocument(slug, WELCOME_MARKDOWN, canonicalizeStoredMarks({}), 'Welcome', WORKSPACE_OWNER_ID, randomUUID());
      await ensureCanonicalYjsBaselineForDocument(slug);
      refreshSnapshotForSlug(slug);
    }
    const access = createDocumentAccessToken(slug, 'editor');
    res.redirect(302, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(access.secret)}`);
  } catch (error) {
    console.error('[workspace] failed to open the workspace', error);
    res.status(500).type('text').send('Could not open the workspace.');
  }
}
