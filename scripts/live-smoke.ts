// Exercises the voice agent end to end without a microphone.
//
// The Gemini Live API accepts text turns on the same session the browser uses
// for audio, so this drives the real production path (document creation, token
// minting, the locked session config, tool calling, and the agent bridge) and
// prints the transcript and every tool call. Audio from the model is counted,
// not played.
//
// Usage (secrets come from the environment, never from a file):
//   railway run -- npx tsx scripts/live-smoke.ts
//   PROOF_BASE_URL=http://localhost:4000 PROOF_SHARE_MARKDOWN_API_KEY=... npx tsx scripts/live-smoke.ts

import { GoogleGenAI, type LiveServerMessage } from '@google/genai';

const BASE = (process.env.PROOF_BASE_URL || 'https://proof-live-production.up.railway.app').replace(/\/$/, '');
const SHARE_KEY = process.env.PROOF_SHARE_MARKDOWN_API_KEY || '';
const REQUEST = process.argv.slice(2).join(' ') || 'This reads like a marketing hook. Make it professional.';
// Sent once the first suggestion lands, to exercise reject-then-resuggest.
const FOLLOW_UP = process.env.SMOKE_FOLLOW_UP ?? 'Try again, but keep it to one short sentence.';
const TIMEOUT_MS = 90_000;

const PARAGRAPH =
  'Stop wasting hours on manual reviews! Our game-changing platform slashes turnaround time by 80% and your team will never look back.';
const MARKDOWN = `# Voice smoke test

This document was created by scripts/live-smoke.ts to exercise the voice agent.

${PARAGRAPH}

The remaining text is here so the selection has neighbours.
`;

if (!SHARE_KEY && !process.env.PROOF_SMOKE_SLUG) {
  console.error('PROOF_SHARE_MARKDOWN_API_KEY is required');
  process.exit(1);
}

async function post(path: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  // Reuse a document (for example one a browser has open) instead of creating one.
  const doc = process.env.PROOF_SMOKE_SLUG
    ? { slug: process.env.PROOF_SMOKE_SLUG, accessToken: process.env.PROOF_SMOKE_TOKEN || '', accessRole: 'reused', tokenUrl: `${BASE}/d/${process.env.PROOF_SMOKE_SLUG}?token=${process.env.PROOF_SMOKE_TOKEN}` }
    : await post('/api/share/markdown', { title: 'Voice smoke test', markdown: MARKDOWN }, { 'x-api-key': SHARE_KEY });
  const slug: string = doc.slug;
  const shareToken: string = doc.accessToken;
  console.log(`${stamp()} document ${slug} (${doc.accessRole})`);
  console.log(`  open: ${doc.tokenUrl}`);

  const grant = await post('/api/live/token', { slug }, { 'x-share-token': shareToken });
  console.log(`${stamp()} token minted for ${grant.model}, voice ${grant.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName}`);

  const opsHeaders = { 'x-share-token': shareToken, 'X-Agent-Id': String(grant.actor).replace(/^ai:/, '') };
  const suggestionIds: string[] = [];
  const rejectedIds: string[] = [];

  async function runTool(name: string, args: Record<string, any>) {
    switch (name) {
      case 'get_selection':
        return { selected: true, text: PARAGRAPH, surrounding_block: PARAGRAPH };
      case 'get_document':
        return { markdown: MARKDOWN };
      case 'suggest_replace':
      case 'suggest_insert':
      case 'suggest_delete':
      case 'leave_comment': {
        const kind = name.replace('suggest_', '');
        const op =
          name === 'leave_comment'
            ? { type: 'comment.add', quote: args.quote, text: args.text }
            : { type: 'suggestion.add', kind, quote: args.quote ?? args.after_quote, content: args.replacement ?? args.content };
        const result = await post(`/api/agent/${encodeURIComponent(slug)}/ops`, { ...op, by: grant.actor }, {
          ...opsHeaders,
          'Idempotency-Key': crypto.randomUUID(),
        }).catch((error: Error) => ({ success: false, error: error.message }));
        if (result.success && result.markId) suggestionIds.push(result.markId);
        return result.success ? { ok: true, id: result.markId, status: 'pending author review' } : { error: result.error };
      }
      case 'list_suggestions':
        return { suggestions: suggestionIds.map((id) => ({ id })) };
      case 'reject_suggestions': {
        // Mirrors the browser: the server clears the mark first, as the author.
        const targets: string[] = args.all ? [...suggestionIds] : args.ids?.length ? args.ids : suggestionIds.slice(-1);
        let rejected = 0;
        for (const id of targets) {
          const result = await post(`/api/agent/${encodeURIComponent(slug)}/ops`, { type: 'suggestion.reject', markId: id, by: 'human:smoke' }, {
            'x-share-token': shareToken,
            'Idempotency-Key': crypto.randomUUID(),
          }).catch((error: Error) => ({ success: false, error: error.message }));
          if (result.success) {
            rejected++;
            suggestionIds.splice(suggestionIds.indexOf(id), 1);
            rejectedIds.push(id);
          } else console.log(`${stamp()}   reject ${id} failed: ${result.error}`);
        }
        return { rejected, requested: targets.length };
      }
      case 'accept_suggestions':
        // Accepting runs inside the editor and cannot be driven from here.
        return { error: 'accept is only available in the editor during this smoke test' };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  const ai = new GoogleGenAI({ apiKey: grant.token, httpOptions: { apiVersion: 'v1alpha' } });
  let audioBytes = 0;
  let agentText = '';
  let turns = 0;
  let toolCalls = 0;
  let closed = false;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  let sessionRef: { sendToolResponse(p: any): void; sendClientContent(p: any): void; close(): void } | null = null;

  async function onmessage(message: LiveServerMessage) {
    if (message.setupComplete) console.log(`${stamp()} setup complete`);
    if (message.sessionResumptionUpdate?.newHandle) console.log(`${stamp()} resumption handle received`);
    if (message.goAway) console.log(`${stamp()} goAway`, message.goAway);

    const calls = message.toolCall?.functionCalls ?? [];
    if (calls.length) {
      const functionResponses = [];
      for (const call of calls) {
        toolCalls++;
        const args = (call.args ?? {}) as Record<string, any>;
        console.log(`${stamp()} tool ${call.name}(${JSON.stringify(args)})`);
        const response = await runTool(call.name ?? '', args);
        console.log(`${stamp()}   -> ${JSON.stringify(response)}`);
        functionResponses.push({ id: call.id, name: call.name, response });
      }
      sessionRef?.sendToolResponse({ functionResponses });
    }

    const content = message.serverContent;
    if (!content) return;
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) audioBytes += Buffer.from(part.inlineData.data, 'base64').length;
      if (part.text) console.log(`${stamp()} text part: ${part.text}`);
    }
    if (content.inputTranscription?.text) console.log(`${stamp()} author: ${content.inputTranscription.text}`);
    if (content.outputTranscription?.text) agentText += content.outputTranscription.text;
    if (content.interrupted) console.log(`${stamp()} interrupted`);
    if (content.turnComplete) {
      turns++;
      console.log(`${stamp()} turn ${turns} complete. agent said: "${agentText.trim()}" (audio ${audioBytes} bytes)`);
      agentText = '';
      // One turn with suggestions is what we came for; a turn with no tool
      // calls at all means the model answered without looking at the document.
      if (turns === 1 && suggestionIds.length > 0 && FOLLOW_UP) {
        rejectedIds.length = 0;
        console.log(`${stamp()} sending: "${FOLLOW_UP}"`);
        sessionRef?.sendClientContent({ turns: [{ role: 'user', parts: [{ text: FOLLOW_UP }] }], turnComplete: true });
        return;
      }
      if (suggestionIds.length > 0 || turns >= 3) finish();
    }
  }

  const session = await ai.live.connect({
    model: grant.model,
    config: grant.config,
    callbacks: {
      onopen: () => console.log(`${stamp()} socket open`),
      onmessage: (m) => void onmessage(m).catch((e) => console.error('handler failed', e)),
      onerror: (e) => console.error(`${stamp()} socket error`, (e as any)?.message ?? e),
      onclose: (e) => {
        closed = true;
        console.log(`${stamp()} socket closed`, (e as any)?.code, (e as any)?.reason);
        finish();
      },
    },
  });
  sessionRef = session;

  console.log(`${stamp()} sending: "${REQUEST}"`);
  session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: REQUEST }] }], turnComplete: true });

  const timer = setTimeout(() => {
    console.log(`${stamp()} timed out`);
    finish();
  }, TIMEOUT_MS);
  await done;
  clearTimeout(timer);
  if (!closed) session.close();

  console.log('');
  console.log(`tool calls: ${toolCalls}, pending suggestions: ${suggestionIds.length}, rejected: ${rejectedIds.length}, audio received: ${audioBytes > 0}`);
  console.log(`review in the editor: ${doc.tokenUrl}`);
  process.exit(suggestionIds.length > 0 ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
