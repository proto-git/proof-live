# Proof Live

> An independent fork of [Proof SDK](https://github.com/EveryInc/proof-sdk) by Every, adding real-time voice editing with Gemini Live.
> This is not the hosted [Proof](https://proofeditor.ai) service and is not affiliated with or endorsed by Every. All credit for the editor, collaboration server, and provenance model goes to the Proof SDK authors. See `LICENSE` and `TRADEMARKS.md`.

## What this fork adds

**Talk to your document.** Open a shared document, press **Talk to edit**, select a paragraph, and say what you want:

> "This reads like a marketing hook. Make it professional and instructional."

A Gemini Live voice agent reads your selection, proposes a rewrite as a tracked suggestion attributed to `ai:gemini-live`, and tells you in a sentence what it changed. Say "yes" to accept, "no" to reject, or "try again, shorter". You can talk over it at any time.

How it works:

- The browser streams microphone audio straight to the Gemini Live API over a WebSocket and plays the reply. Audio never passes through this server.
- The server mints a single-use, 30-minute ephemeral token per session (`POST /api/live/token`). The token locks the model, system instruction, and tools, so the browser cannot change them and never sees the API key.
- Minting requires a real edit token for an existing document. A bare slug is not enough, because sessions spend the deployment owner's Gemini quota.
- The agent only acts through tools, and never writes text directly. Suggestions and comments go through the existing agent bridge (`POST /documents/:slug/ops`), so they sync to every collaborator, carry provenance, and show the agent in presence. Accept and reject run in the editor.
- Sessions survive Gemini's ~10 minute connection limit by reconnecting with a resumption handle, with sliding-window context compression for long sessions.

Code: `server/live-config.ts` (instruction and tools), `server/live-routes.ts` (token route), `src/voice/` (audio, session, tools, panel), `src/tests/voice-tools.test.ts`.

### Shared workspace (optional)

Set `PROOF_PUBLIC_WORKSPACE=1` and the editor gains a sidebar listing the workspace's documents, with **New** and **Import** (Markdown files, by button or drag and drop). `/workspace` is a single address that lands on the most recently edited document. With the workspace on, the voice agent also gets `list_documents` and `read_document`, so you can say "pull the deployment numbers from the Q2 update" while editing a different document. It can read other documents but only suggests changes in the open one.

This is for demos and for deployments that sit behind their own access control: **anyone who can reach the site can open, create, and edit workspace documents.** Only documents created through the workspace are listed; documents shared by link stay private. Real multi-user access needs accounts in front of `server/workspace-routes.ts`.

Code: `server/workspace-routes.ts`, `src/workspace/sidebar.ts`.

### Voice configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | yes, for voice | none | Gemini API key from Google AI Studio. Without it the editor works normally and the voice button shows as not configured. |
| `GEMINI_LIVE_MODEL` | no | `gemini-3.8-live` | Try `gemini-3.8-live-extended-thinking` for harder rewrites. |
| `GEMINI_LIVE_VOICE` | no | `Kore` | Any prebuilt voice name. Audition them in AI Studio. |

Use a headset, or keep echo cancellation on, so the agent does not hear itself through your speakers.

To check a deployment without a microphone, `scripts/live-smoke.ts` drives the same session with text turns: it creates a document, mints a voice token, asks for a rewrite, then says "try again", and prints every tool call. It needs `PROOF_SHARE_MARKDOWN_API_KEY` (and `PROOF_BASE_URL` for anything other than the Railway deployment) in the environment, for example `railway run -- npx tsx scripts/live-smoke.ts`.

### Self-hosting fixes in this fork

Upstream's public extraction does not run correctly self-hosted as of `fb25787`. This fork fixes what it needed:

- **`dist/` is now served**, so `/assets/editor.js` loads (upstream issues #73, #52).
- **New documents are mutation-ready.** `POST /documents` now seeds the Yjs baseline, and the stored markdown is normalized to the editor's serializer output so the two agree. Without this, accept and reject fail with `PROJECTION_STALE` forever (upstream issue #43).
- **Accepting a suggestion no longer corrupts the document.** In share mode, accept asked the server to rewrite its canonical copy while the browser held the live document; the merge duplicated text and left the suggestion pending. Accept is now applied in the editor and syncs out like any other edit, which is how reject already worked.
- **`npm run build` works on Windows** (`scripts/finalize-web-build.mjs` path handling).
- Set **`COLLAB_EMBEDDED_WS=1`** for single-process deployments, or the client builds a WebSocket URL for a port nothing listens on.

Run it: `npm install`, `npm run build`, then `COLLAB_EMBEDDED_WS=1 GEMINI_API_KEY=... npm run serve`, create a document with `POST /documents`, and open the returned `tokenUrl`.

---

The rest of this README is upstream's.

# Proof SDK

Proof SDK is the open-source editor, collaboration server, provenance model, and agent HTTP bridge that power collaborative documents in Proof.

If you want the hosted product, use [Proof](https://proofeditor.ai). Hosted Proof is made by [Every](https://every.to).

## What Is Included

- Collaborative markdown editor with provenance tracking
- Comments, suggestions, and rewrite operations
- Realtime collaboration server
- Agent HTTP bridge for state, marks, edits, presence, and events
- A small example app under `apps/proof-example`

## Workspace Layout

- `packages/doc-core`
- `packages/doc-editor`
- `packages/doc-server`
- `packages/doc-store-sqlite`
- `packages/agent-bridge`
- `apps/proof-example`
- `server`
- `src`

## Local Development

Requirements:

- Node.js 18+

Install dependencies:

```bash
npm install
```

Start the editor:

```bash
npm run dev
```

Start the local server:

```bash
npm run serve
```

The default setup serves the editor on `http://localhost:3000` and the API/server on `http://localhost:4000`.

## Core Routes

Canonical Proof SDK routes:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/edit`
- `POST /documents/:slug/edit/v2`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

Compatibility aliases remain mounted for the hosted product, but the routes above are the public SDK surface.

## Build

```bash
npm run build
```

The build outputs the web bundle to `dist/` and writes `dist/web-artifact-manifest.json`.

## Tests

```bash
npm test
```

## Docs

- `AGENT_CONTRACT.md`
- `docs/agent-docs.md`
- `docs/proof.SKILL.md`
- `docs/adr/2026-03-proof-sdk-public-core.md`

## License

- Code: `MIT` in `LICENSE`
- Trademark guidance: `TRADEMARKS.md`
