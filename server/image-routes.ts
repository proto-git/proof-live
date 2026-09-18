// Agent-made images. The voice agent asks for a picture; the server generates it
// with the deployment's Gemini key, keeps the file beside the database (the
// mounted volume in production), and hands back a URL for a Markdown image.
//
// Like minting a voice token, this spends the owner's quota, so the caller must
// present a real access token with edit rights for an existing document.

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDocumentAccessRole } from './db.js';
import { cutOutBackground, promptForCutout } from './image-cutout.js';
import { createRateLimiter } from './rate-limiter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const IMAGE_ROLES = new Set(['editor', 'owner_bot']);
const ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);
const MAX_PROMPT_CHARS = 2000;
const FILE_PATTERN = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function getImageModel(): string {
  return (process.env.GEMINI_IMAGE_MODEL || '').trim() || DEFAULT_IMAGE_MODEL;
}

export function getImageDir(): string {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'proof-share.db');
  return path.join(path.dirname(dbPath), 'generated-images');
}

export type GeneratedImage = { data: Buffer; mimeType: string };
export type ImageGenerator = (prompt: string, aspectRatio: string) => Promise<GeneratedImage>;

export class ImageGenerationError extends Error {
  constructor(message: string, readonly code: 'IMAGE_QUOTA' | 'IMAGE_REFUSED' | 'IMAGE_FAILED') {
    super(message);
  }
}

async function generateWithGemini(prompt: string, aspectRatio: string): Promise<GeneratedImage> {
  const response = await fetch(INTERACTIONS_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': (process.env.GEMINI_API_KEY || '').trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: getImageModel(),
      input: prompt,
      response_format: { type: 'image', aspect_ratio: aspectRatio },
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; mime_type?: string }> }>;
  } | null;
  if (response.status === 429) {
    throw new ImageGenerationError(body?.error?.message ?? 'Image quota exceeded', 'IMAGE_QUOTA');
  }
  if (!response.ok) {
    throw new ImageGenerationError(body?.error?.message ?? `Image model returned ${response.status}`, 'IMAGE_FAILED');
  }
  for (const step of body?.steps ?? []) {
    for (const block of step.content ?? []) {
      if (block.type === 'image' && block.data) {
        return { data: Buffer.from(block.data, 'base64'), mimeType: block.mime_type ?? 'image/png' };
      }
    }
  }
  throw new ImageGenerationError('The image model answered without an image', 'IMAGE_REFUSED');
}

let generator: ImageGenerator = generateWithGemini;

/** Tests swap the generator so no request leaves the machine. */
export function setImageGeneratorForTests(next: ImageGenerator | null): void {
  generator = next ?? generateWithGemini;
}

function getPresentedSecret(req: Request): string | null {
  const header = req.header('x-share-token');
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.header('authorization');
  const match = typeof auth === 'string' ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || null;
}

const imageRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 6,
  keyFn: (req: Request) => {
    const trustProxy = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
    if (trustProxy === '1' || trustProxy === 'true') {
      const first = req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  },
});

export const imageRoutes = Router();

imageRoutes.post('/live/image', imageRateLimiter, async (req: Request, res: Response) => {
  if (!(process.env.GEMINI_API_KEY || '').trim() && generator === generateWithGemini) {
    res.status(503).json({ error: 'Image generation is not configured on this server', code: 'IMAGE_NOT_CONFIGURED' });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const secret = getPresentedSecret(req);
  if (!slug || !secret) {
    res.status(401).json({ error: 'A document slug and access token are required', code: 'IMAGE_AUTH_REQUIRED' });
    return;
  }
  const role = resolveDocumentAccessRole(slug, secret);
  if (!role || !IMAGE_ROLES.has(role)) {
    res.status(403).json({ error: 'Generating images needs edit access to this document', code: 'IMAGE_FORBIDDEN' });
    return;
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `A prompt of at most ${MAX_PROMPT_CHARS} characters is required`, code: 'IMAGE_BAD_PROMPT' });
    return;
  }
  const aspectRatio = typeof body.aspectRatio === 'string' && ASPECT_RATIOS.has(body.aspectRatio) ? body.aspectRatio : '1:1';
  const transparent = body.transparent === true;

  try {
    let image = await generator(transparent ? promptForCutout(prompt) : prompt, aspectRatio);
    let transparentApplied = false;
    if (transparent) {
      const cutOut = await cutOutBackground(image.data).catch(() => null);
      if (cutOut) {
        image = { data: cutOut, mimeType: 'image/png' };
        transparentApplied = true;
      }
    }
    const extension = EXTENSIONS[image.mimeType];
    if (!extension) throw new ImageGenerationError(`Unexpected image type ${image.mimeType}`, 'IMAGE_FAILED');
    const file = `${randomUUID()}.${extension}`;
    await mkdir(getImageDir(), { recursive: true });
    await writeFile(path.join(getImageDir(), file), image.data);
    res.json({ url: `/generated/${file}`, mimeType: image.mimeType, ...(transparent ? { transparent: transparentApplied } : {}) });
  } catch (error) {
    const code = error instanceof ImageGenerationError ? error.code : 'IMAGE_FAILED';
    console.error('[image] generation failed', code, error instanceof Error ? error.message : error);
    res.status(code === 'IMAGE_QUOTA' ? 429 : 502).json({
      error:
        code === 'IMAGE_QUOTA'
          ? 'The image model has no quota on this server\'s API key'
          : code === 'IMAGE_REFUSED'
            ? 'The image model declined to draw that'
            : 'The image could not be generated',
      code,
    });
  }
});

// Files are named by the server (a UUID), so the name is the whole lookup.
export function serveGeneratedImage(req: Request, res: Response): void {
  const file = String(req.params.file ?? '');
  if (!FILE_PATTERN.test(file)) {
    res.status(404).end();
    return;
  }
  res.sendFile(file, { root: getImageDir(), maxAge: '365d', immutable: true }, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
}
