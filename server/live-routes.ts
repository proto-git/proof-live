// Voice agent routes. Mints short-lived, single-use Gemini Live tokens so the
// browser can open the audio socket directly without ever seeing the API key.
//
// Minting spends the deployment owner's Gemini quota, so it is stricter than
// the rest of the share surface: the caller must present a real access token
// with edit rights for an existing document. A bare slug is not enough here.

import { Router, type Request, type Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import { resolveDocumentAccessRole } from './db.js';
import { createRateLimiter } from './rate-limiter.js';
import { buildLiveSessionConfig, getLiveModel, getLiveVoice, LIVE_AGENT_ACTOR } from './live-config.js';

const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const NEW_SESSION_WINDOW_MS = 60 * 1000;
const VOICE_ROLES = new Set(['editor', 'owner_bot']);

function getApiKey(): string | null {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return key.length > 0 ? key : null;
}

function getPresentedSecret(req: Request): string | null {
  const header = req.header('x-share-token');
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.header('authorization');
  const match = typeof auth === 'string' ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || null;
}

function clientKey(req: Request): string {
  const trustProxy = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
  if (trustProxy === '1' || trustProxy === 'true') {
    const first = req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

const tokenRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 12,
  keyFn: clientKey,
});

export const liveRoutes = Router();

liveRoutes.get('/live/status', (_req: Request, res: Response) => {
  res.json({
    configured: getApiKey() !== null,
    model: getLiveModel(),
    voice: getLiveVoice(),
    actor: LIVE_AGENT_ACTOR,
  });
});

liveRoutes.post('/live/token', tokenRateLimiter, async (req: Request, res: Response) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(503).json({ error: 'Voice is not configured on this server', code: 'LIVE_NOT_CONFIGURED' });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const secret = getPresentedSecret(req);
  if (!slug || !secret) {
    res.status(401).json({ error: 'A document slug and access token are required', code: 'LIVE_AUTH_REQUIRED' });
    return;
  }

  const role = resolveDocumentAccessRole(slug, secret);
  if (!role || !VOICE_ROLES.has(role)) {
    res.status(403).json({ error: 'Voice editing needs edit access to this document', code: 'LIVE_FORBIDDEN' });
    return;
  }

  const resumeHandle = typeof body.resumeHandle === 'string' ? body.resumeHandle : null;
  const model = getLiveModel();
  const config = buildLiveSessionConfig({ resumeHandle });
  const now = Date.now();

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + TOKEN_LIFETIME_MS).toISOString(),
        newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
        liveConnectConstraints: { model, config },
      },
    });
    if (!token.name) throw new Error('Token response had no name');
    res.json({ token: token.name, model, config, actor: LIVE_AGENT_ACTOR });
  } catch (error) {
    console.error('[live] failed to mint ephemeral token', error);
    res.status(502).json({ error: 'Could not start a voice session', code: 'LIVE_TOKEN_FAILED' });
  }
});
