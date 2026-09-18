// Tool handlers for the voice agent. Everything the agent does lands as a
// tracked suggestion or comment attributed to it. It never writes text directly.
//
// Two paths, chosen by what was verified to be reliable against a live
// collaborative session:
//   - Creating suggestions and comments goes through the server's agent bridge
//     (POST /api/agent/:slug/ops). The server anchors the quote, records the
//     agent as author, shows it in presence, and syncs to every collaborator.
//   - Accepting and rejecting runs in the editor, because the author is the one
//     deciding and the result syncs out like any other edit.
//
// Declarations live on the server (server/live-config.ts) because they are
// locked into the session token. Names here must match.

import type { Mark } from '../formats/marks';

export type ToolResult = Record<string, unknown>;

export interface VoiceEditorApi {
  getSelectionContext(): { text: string; block: string; from: number; to: number } | null;
  getMarkdownSnapshot(): { content: string } | null;
  getPendingMarkSuggestions(): Mark[];
  markAccept(markId: string): boolean;
  markReject(markId: string): boolean;
  navigateToMark(markId: string): boolean;
}

export interface VoiceToolContext {
  slug: string;
  shareToken: string;
  // Base URL of the document server's API, for example "https://host/api".
  apiBase: string;
  actor: string;
  // The human at this editor, for example "human:Dan".
  getAuthorActor(): string;
  editor: VoiceEditorApi;
  // How long to wait for a new suggestion to show up in this editor.
  markVisibleTimeoutMs?: number;
}

const MAX_DOCUMENT_CHARS = 60_000;
// Marks created on the server reach this editor over the collab socket shortly after.
const MARK_SYNC_DELAY_MS = 1200;
const PROJECTION_RETRY_LIMIT = 3;
const PROJECTION_RETRY_DELAY_MS = 600;

const MARK_VISIBLE_TIMEOUT_MS = 5000;
const MARK_VISIBLE_POLL_MS = 150;

const NOT_ANCHORED =
  'The suggestion could not be placed in the document, so it was withdrawn and nothing changed. Quote the plain text exactly as it reads, without Markdown symbols such as #, *, - or >, and try again.';

// The model reads Markdown, so it tends to quote "# Title" or "* item". The
// editor anchors quotes against rendered text, where those markers do not exist.
const BLOCK_PREFIX = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;

function stripBlockPrefix(text: string): { text: string; prefix: string } {
  if (text.includes('\n')) return { text, prefix: '' };
  const match = text.match(BLOCK_PREFIX);
  return match ? { text: text.slice(match[0].length), prefix: match[0].trim() } : { text, prefix: '' };
}

const MULTI_BLOCK_QUOTE =
  'That quote spans more than one paragraph, and a suggestion has to stay inside one paragraph, heading, or list item. Make one suggestion per paragraph. To merge several paragraphs into one block (a list, for example), replace the first paragraph with the full new content and use suggest_delete on each of the others.';

const BLOCK_ANCHOR_REQUIRED =
  'A new paragraph, section, or list has to be anchored on a whole paragraph or a whole heading, quoted in full. Call get_document, pick the paragraph or heading next to where the new content belongs, and pass position "before" or "after".';

const LIST_ANCHOR_REFUSED =
  'A whole list cannot be the anchor. To add content after a list, quote its last item in full and pass position "after"; the new content is placed below the list. To add content above a list, quote its first item and pass position "before". To add an item to the list itself, use suggest_replace on the last item with both items as the replacement.';

// Content that introduces its own block: a heading, a list, a quote, a fenced
// block (a Mermaid diagram), an image on its own, or more than one paragraph.
// Anything else is inline text that joins the anchor's block.
function isBlockContent(content: string): boolean {
  const trimmed = content.trim();
  if (/^(?:```|~~~)/.test(trimmed) || /^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) return true;
  return /\n\s*\n/.test(trimmed) || BLOCK_PREFIX.test(trimmed) || /\n\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(trimmed);
}

function joinInline(first: string, second: string): string {
  const needsSpace = !/\s$/.test(first) && !/^[\s.,;:!?)]/.test(second);
  return needsSpace ? `${first} ${second.trim()}` : `${first}${second}`;
}

// The rendered text of a Markdown block, close enough to what the author sees
// (and the model quotes) to compare against.
function blockPlainText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(BLOCK_PREFIX, ''))
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findWholeBlock(markdown: string, anchor: string): { raw: string; kind: 'paragraph' | 'heading' | 'list' | 'list-item' } | null {
  const wanted = anchor.replace(/(\*\*|__|\*|_|~~|`)/g, '').replace(/\s+/g, ' ').trim();
  for (const chunk of markdown.split(/\n\s*\n/)) {
    const raw = chunk.trim();
    if (!raw) continue;
    const listLike = raw.split('\n').some((line) => /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|>)/.test(line));
    if (listLike) {
      // One whole item can anchor a new block: the editor places the block outside
      // the list (after it, or before it). The list as a whole cannot be quoted.
      const item = raw.split('\n').find((line) => blockPlainText(line) === wanted);
      if (item) return { raw: item.replace(BLOCK_PREFIX, '').trim(), kind: 'list-item' };
      if (blockPlainText(raw) === wanted) return { raw, kind: 'list' };
      continue;
    }
    if (blockPlainText(raw) === wanted) return { raw, kind: /^\s{0,3}#{1,6}\s/.test(raw) ? 'heading' : 'paragraph' };
  }
  return null;
}

// A fenced block (a Mermaid diagram, a code sample) is one unit to the editor. An
// edit inside it has to arrive as "the whole block, replaced by a whole fenced
// block": replacement code without its fence is parsed as prose on accept, which
// turns the diagram into a paragraph plus a stray code block.
interface FencedBlock {
  info: string;
  code: string;
}

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/;

function findFencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { marker: string; info: string; lines: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    const fence = line.match(FENCE_LINE);
    if (!open) {
      if (fence) open = { marker: fence[1], info: fence[2].trim(), lines: [] };
    } else if (fence && fence[1].startsWith(open.marker) && !fence[2].trim()) {
      blocks.push({ info: open.info, code: open.lines.join('\n') });
      open = null;
    } else open.lines.push(line);
  }
  return blocks;
}

function stripFence(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length >= 2 && FENCE_LINE.test(lines[0]) && FENCE_LINE.test(lines[lines.length - 1])) return lines.slice(1, -1).join('\n');
  return text;
}

// Code compared without its indentation and blank lines, which is how loosely a model copies it.
function looseCode(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

function fencedEdit(markdown: string, quote: string, replacement: string): { quote: string; content: string } | null {
  const quoted = stripFence(quote);
  const wanted = looseCode(quoted);
  if (!wanted) return null;
  const block = findFencedBlocks(markdown).find((candidate) => looseCode(candidate.code).includes(wanted));
  if (!block) return null;
  const whole = looseCode(block.code) === wanted;
  // Part of the code quoted: swap that part. If it is not there character for
  // character, the model has to quote the whole block instead.
  if (!whole && !block.code.includes(quoted.trim())) return null;
  const code = whole ? stripFence(replacement).replace(/^\n+|\s+$/g, '') : block.code.replace(quoted.trim(), stripFence(replacement).trim());
  return { quote: block.code, content: '```' + block.info + '\n' + code + '\n```' };
}

const QUOTE_NOT_FOUND =
  'That exact text was not found in the document. Call get_selection or get_document, copy the passage character for character, and try again.';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

// The editor's markdown snapshot embeds review metadata (suggestion spans and a
// trailing PROOF comment block). The model should see the prose only.
function stripReviewMetadata(markdown: string): string {
  return markdown
    .replace(/<!--\s*PROOF[\s\S]*$/, '')
    .replace(/<span data-proof="[^"]*"[^>]*>([\s\S]*?)<\/span>/g, '$1')
    // An accepted code fence carries its provenance on the info string.
    .replace(/^(\s*(?:`{3,}|~{3,})\S*) proof:\S+$/gm, '$1')
    .trimEnd();
}

function describeSuggestion(mark: Mark): ToolResult {
  const data = (mark.data ?? {}) as Record<string, unknown>;
  return {
    id: mark.id,
    kind: mark.kind,
    by: mark.by,
    original: mark.quote,
    proposed: typeof data.content === 'string' ? data.content : undefined,
  };
}

export class VoiceToolRunner {
  // Suggestions from the agent's latest batch, so "yes" and "try again" work
  // without the model having to track ids.
  private recentSuggestionIds: string[] = [];
  private batchOpen = false;
  // Suggestions made since the author last spoke. The author has not had a
  // chance to look at these, so the agent may not accept them yet.
  private unseenSuggestionIds = new Set<string>();

  constructor(private readonly context: VoiceToolContext) {}

  // The session calls this when the author starts a new turn. The next
  // suggestion then starts a fresh batch rather than extending the old one.
  endBatch(): void {
    this.batchOpen = false;
    this.unseenSuggestionIds.clear();
  }

  async run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.dispatch(name, args);
      // Kept on purpose: when the agent says it did something it did not, this
      // line in the browser console is the only record of what really happened.
      console.log(`[voice] tool ${name}`, JSON.stringify(args), '->', JSON.stringify(result).slice(0, 400));
      return result;
    } catch (error) {
      console.error(`[voice] tool ${name} failed`, error);
      return { error: error instanceof Error ? error.message : 'Tool failed' };
    }
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { editor } = this.context;
    switch (name) {
      case 'get_selection': {
        const selection = editor.getSelectionContext();
        if (!selection || !selection.text.trim()) {
          return { selected: false, note: 'Nothing is selected. Call get_document to read the text.' };
        }
        return { selected: true, text: selection.text, surrounding_block: selection.block };
      }

      case 'get_document': {
        const content = stripReviewMetadata(editor.getMarkdownSnapshot()?.content ?? '');
        if (content.length > MAX_DOCUMENT_CHARS) {
          return { markdown: content.slice(0, MAX_DOCUMENT_CHARS), truncated: true };
        }
        return { markdown: content };
      }

      case 'suggest_replace': {
        const stripped = stripBlockPrefix(asString(args.quote));
        const quote = stripped.text;
        let content = asString(args.replacement);
        if (!quote || !content) return { error: 'quote and replacement are required' };
        const fenced = fencedEdit(stripReviewMetadata(editor.getMarkdownSnapshot()?.content ?? ''), asString(args.quote), content);
        if (fenced) return this.addSuggestion({ kind: 'replace', ...fenced }, { wholeBlock: true });
        // "# Old title" -> "# New title" means the text changes and the block
        // stays what it is, so the same marker comes off the replacement too.
        const contentPrefix = stripBlockPrefix(content);
        if (stripped.prefix && contentPrefix.prefix === stripped.prefix) content = contentPrefix.text;
        return this.addSuggestion({ kind: 'replace', quote, content });
      }

      case 'suggest_insert': {
        const quote = stripBlockPrefix(asString(args.anchor_quote) || asString(args.after_quote)).text;
        const content = asString(args.content);
        if (!quote || !content) return { error: 'anchor_quote and content are required' };
        return this.addInsertion(quote, content, args.position === 'before' ? 'before' : 'after');
      }

      case 'insert_image': {
        const quote = stripBlockPrefix(asString(args.anchor_quote)).text;
        const prompt = asString(args.prompt).trim();
        if (!quote || !prompt) return { error: 'anchor_quote and prompt are required' };
        return this.addImage(quote, prompt, asString(args.alt), asString(args.aspect_ratio), args.transparent_background === true, args.position === 'before' ? 'before' : 'after');
      }

      case 'suggest_delete': {
        const quote = stripBlockPrefix(asString(args.quote)).text;
        if (!quote) return { error: 'quote is required' };
        return this.addSuggestion({ kind: 'delete', quote });
      }

      case 'leave_comment': {
        const quote = asString(args.quote);
        const text = asString(args.text);
        if (!quote || !text) return { error: 'quote and text are required' };
        const result = await this.postOp({ type: 'comment.add', quote, text });
        if (!result.ok) return { error: result.error };
        this.revealWhenSynced(result.markId);
        return { ok: true, id: result.markId };
      }

      case 'list_suggestions':
        return { suggestions: editor.getPendingMarkSuggestions().map(describeSuggestion) };

      case 'accept_suggestions':
        return this.resolveSuggestions(args, async (id) => editor.markAccept(id), 'accepted');

      case 'reject_suggestions':
        // Order matters. A rejected suggestion leaves the text unchanged, so if
        // the server still holds the mark as pending it re-anchors and syncs it
        // straight back into the editor. Clear it on the server first, then here.
        return this.resolveSuggestions(
          args,
          async (id) => {
            const result = await this.postOp({ type: 'suggestion.reject', markId: id }, { asAuthor: true });
            return result.ok && editor.markReject(id);
          },
          'rejected',
        );

      case 'list_documents': {
        const documents = await this.fetchWorkspaceDocuments();
        if (!documents) return { error: 'The document list is not available right now.' };
        return {
          documents: documents.map((doc) => ({
            id: doc.slug,
            title: doc.title,
            open_now: doc.slug === this.context.slug,
          })),
        };
      }

      case 'read_document':
        return this.readWorkspaceDocument(asString(args.document).trim());

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  private async fetchWorkspaceDocuments(): Promise<Array<{ slug: string; title: string }> | null> {
    const response = await fetch(`${this.context.apiBase}/workspace/documents`);
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { documents?: Array<{ slug: string; title: string }> } | null;
    return body?.documents ?? null;
  }

  // The author names documents the way people do: "the Q2 update". Match the id
  // exactly, then the title exactly, then as a fragment, and when more than one
  // fits hand the choices back so the model asks.
  private async readWorkspaceDocument(wanted: string): Promise<ToolResult> {
    if (!wanted) return { error: 'document is required' };
    const documents = await this.fetchWorkspaceDocuments();
    if (!documents) return { error: 'The document list is not available right now.' };

    const needle = wanted.toLowerCase();
    const byId = documents.filter((doc) => doc.slug === wanted);
    const exact = documents.filter((doc) => doc.title.toLowerCase() === needle);
    const partial = documents.filter((doc) => doc.title.toLowerCase().includes(needle));
    const matches = byId.length ? byId : exact.length ? exact : partial;

    if (matches.length === 0) {
      return { error: `No document matches "${wanted}".`, available: documents.map((doc) => doc.title) };
    }
    if (matches.length > 1) {
      return {
        error: 'More than one document matches. Ask the author which one, or pass an id.',
        matches: matches.map((doc) => ({ id: doc.slug, title: doc.title })),
      };
    }
    if (matches[0].slug === this.context.slug) {
      return { error: 'That is the document already open. Use get_document for its current text.' };
    }

    const response = await fetch(`${this.context.apiBase}/workspace/documents/${encodeURIComponent(matches[0].slug)}/content`);
    const body = (await response.json().catch(() => null)) as { title?: string; markdown?: string } | null;
    if (!response.ok || typeof body?.markdown !== 'string') return { error: 'That document could not be read.' };
    const markdown = body.markdown;
    return {
      id: matches[0].slug,
      title: body.title ?? matches[0].title,
      markdown: markdown.slice(0, MAX_DOCUMENT_CHARS),
      ...(markdown.length > MAX_DOCUMENT_CHARS ? { truncated: true } : {}),
    };
  }

  // An insertion is proposed as a replacement of its anchor with "anchor plus
  // new content". The editor's own insert suggestions treat the anchored text as
  // the text being inserted, so accepting a bridge-created insert with block
  // content (a new section, a list) replaces the anchor and loses it. Replacing
  // a whole paragraph or heading with several blocks is reliable.
  private async addInsertion(anchor: string, content: string, position: 'before' | 'after'): Promise<ToolResult> {
    if (!isBlockContent(content)) {
      const joined = position === 'before' ? joinInline(content, anchor) : joinInline(anchor, content);
      return this.addSuggestion({ kind: 'replace', quote: anchor, content: joined });
    }

    const snapshot = stripReviewMetadata(this.context.editor.getMarkdownSnapshot()?.content ?? '');
    const block = findWholeBlock(snapshot, anchor);
    if (!block) return { error: BLOCK_ANCHOR_REQUIRED };
    if (block.kind === 'list') return { error: LIST_ANCHOR_REFUSED };

    const addition = content.trim();
    const replacement = position === 'before' ? `${addition}\n\n${block.raw}` : `${block.raw}\n\n${addition}`;
    return this.addSuggestion({ kind: 'replace', quote: anchor, content: replacement });
  }

  // The anchor is checked before the image is made: generating costs quota and
  // several seconds, and a picture that cannot be placed is wasted.
  private async addImage(
    anchor: string,
    prompt: string,
    alt: string,
    aspectRatio: string,
    transparent: boolean,
    position: 'before' | 'after',
  ): Promise<ToolResult> {
    const snapshot = stripReviewMetadata(this.context.editor.getMarkdownSnapshot()?.content ?? '');
    const block = findWholeBlock(snapshot, anchor);
    if (!block) return { error: BLOCK_ANCHOR_REQUIRED };
    if (block.kind === 'list') return { error: LIST_ANCHOR_REFUSED };

    const { slug, shareToken, apiBase } = this.context;
    const response = await fetch(`${apiBase}/live/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': shareToken },
      body: JSON.stringify({ slug, prompt, aspectRatio, transparent }),
    });
    const body = (await response.json().catch(() => null)) as { url?: string; error?: string; transparent?: boolean } | null;
    if (!response.ok || !body?.url) {
      return { error: `${body?.error ?? 'The image could not be generated'}. Nothing was added to the document. Tell the author; do not retry unless they ask.` };
    }
    const label = (alt.trim() || prompt).replace(/[\[\]\n]/g, ' ').slice(0, 120).trim();
    const result = await this.addInsertion(anchor, `![${label}](${body.url})`, position);
    // The cut-out can fail when the model does not draw a plain background.
    if (transparent && body.transparent === false && result.ok) {
      return { ...result, note: 'The background could not be removed, so the image has a plain background. Tell the author.' };
    }
    return result;
  }

  private async addSuggestion(
    op: { kind: 'replace' | 'insert' | 'delete'; quote: string; content?: string },
    options?: { wholeBlock?: boolean },
  ): Promise<ToolResult> {
    // The editor can display a suggestion that spans paragraphs but cannot apply
    // one, so it would sit there unacceptable. One block per suggestion; the
    // replacement itself may still be several blocks (a paragraph into a list).
    // (A fenced block is one block however many blank lines its code has.)
    if (!options?.wholeBlock && /\n\s*\n/.test(op.quote.trim())) return { error: MULTI_BLOCK_QUOTE };

    // Two pending suggestions on the same text cannot both be shown: the editor
    // renders one suggestion mark per range and thrashes when two compete. Make
    // the model resolve the existing one first instead of stacking a new one.
    const overlapping = this.context.editor
      .getPendingMarkSuggestions()
      .find((mark) => mark.quote && (mark.quote.includes(op.quote) || op.quote.includes(mark.quote)));
    if (overlapping) {
      return {
        error: `That text already has a pending suggestion (id ${overlapping.id}). Call reject_suggestions or accept_suggestions with that id first, then suggest again.`,
        pending_id: overlapping.id,
      };
    }

    const result = await this.postOp({ type: 'suggestion.add', ...op });
    if (!result.ok) return { error: result.error };

    // The server accepting a suggestion does not mean the author can see it.
    // Report success only once it is pending in this editor; otherwise take it
    // back so the agent is never confident about a change that does not exist.
    if (result.markId && !(await this.waitUntilVisible(result.markId))) {
      await this.postOp({ type: 'suggestion.reject', markId: result.markId }, { asAuthor: true });
      return { error: NOT_ANCHORED };
    }
    if (!this.batchOpen) {
      this.recentSuggestionIds = [];
      this.batchOpen = true;
    }
    if (result.markId) {
      this.recentSuggestionIds.push(result.markId);
      this.unseenSuggestionIds.add(result.markId);
    }
    this.revealWhenSynced(result.markId);
    return { ok: true, id: result.markId, status: 'pending author review' };
  }

  // asAuthor: the op records the human's decision (rejecting a suggestion), so
  // it is attributed to them and does not count as agent presence.
  private async postOp(
    body: Record<string, unknown>,
    options?: { asAuthor?: boolean },
  ): Promise<{ ok: true; markId?: string } | { ok: false; error: string }> {
    const { slug, shareToken, apiBase } = this.context;
    const actor = options?.asAuthor ? this.context.getAuthorActor() : this.context.actor;
    // One key for every attempt, so a retry can never create the mark twice.
    const idempotencyKey = crypto.randomUUID();
    let response: Response;
    let payload: { success?: boolean; markId?: string; error?: string; code?: string };

    for (let attempt = 0; ; attempt++) {
      // The agent bridge is mounted at /documents and at /api/agent. The /api
      // form goes through the same configured origin (and dev proxy) as the
      // rest of the share client.
      response = await fetch(`${apiBase}/agent/${encodeURIComponent(slug)}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': shareToken,
          // Presence: lists the agent as a collaborator on the document.
          ...(options?.asAuthor ? {} : { 'X-Agent-Id': actor.replace(/^ai:/, '') }),
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ ...body, by: actor }),
      });
      payload = (await response.json().catch(() => ({}))) as typeof payload;
      if (response.ok && payload.success) return { ok: true, markId: payload.markId };

      // Writes that arrive right behind another one can find the server still
      // folding the previous change into its projection. It clears within a
      // second or two, and the server asks for a retry.
      if (payload.code !== 'PROJECTION_STALE' || attempt >= PROJECTION_RETRY_LIMIT) break;
      await new Promise((resolve) => setTimeout(resolve, PROJECTION_RETRY_DELAY_MS * (attempt + 1)));
    }

    const message = payload.error || `Request failed (${response.status})`;
    const anchorMissing = payload.code === 'ANCHOR_NOT_FOUND' || /not found in document/i.test(message);
    return { ok: false, error: anchorMissing ? QUOTE_NOT_FOUND : message };
  }

  private async waitUntilVisible(markId: string): Promise<boolean> {
    const deadline = Date.now() + (this.context.markVisibleTimeoutMs ?? MARK_VISIBLE_TIMEOUT_MS);
    for (;;) {
      if (this.context.editor.getPendingMarkSuggestions().some((mark) => mark.id === markId)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, MARK_VISIBLE_POLL_MS));
    }
  }

  private revealWhenSynced(markId: string | undefined): void {
    if (!markId) return;
    window.setTimeout(() => {
      try {
        this.context.editor.navigateToMark(markId);
      } catch {
        // The mark has not arrived yet; the suggestion is still visible in the text.
      }
    }, MARK_SYNC_DELAY_MS);
  }

  private async resolveSuggestions(
    args: Record<string, unknown>,
    apply: (id: string) => Promise<boolean>,
    verb: string,
  ): Promise<ToolResult> {
    const pendingMarks = this.context.editor.getPendingMarkSuggestions();
    const pending = new Set(pendingMarks.map((mark) => mark.id));
    const mine = pendingMarks.filter((mark) => mark.by === this.context.actor).map((mark) => mark.id);
    let targets = asStringArray(args.ids);
    if (args.all === true) targets = [...pending];
    else if (targets.length === 0) {
      // "Accept those" means everything the agent has on the table, which may
      // span several turns (a clarifying question in between starts a new
      // batch). "Try again" is about the latest attempt only.
      const latest = this.recentSuggestionIds.filter((id) => pending.has(id));
      targets = verb === 'accepted' || latest.length === 0 ? mine : latest;
    }

    // Accepting is the author's decision. A suggestion created in this same turn
    // was never in front of them, whatever they said before it existed.
    if (verb === 'accepted') {
      const unseen = targets.filter((id) => this.unseenSuggestionIds.has(id));
      if (unseen.length > 0) {
        targets = targets.filter((id) => !this.unseenSuggestionIds.has(id));
        if (targets.length === 0) {
          return {
            accepted: 0,
            waiting_for_author: unseen.length,
            note: 'Those suggestions were only just made and the author has not seen them. Say what you suggested and wait for them to accept.',
          };
        }
      }
    }

    if (targets.length === 0) return { [verb]: 0, note: 'There were no matching pending suggestions.' };

    const done: string[] = [];
    for (const id of targets) {
      if (pending.has(id) && (await apply(id))) done.push(id);
    }
    this.recentSuggestionIds = this.recentSuggestionIds.filter((id) => !done.includes(id));
    if (done.length < targets.length && verb === 'accepted') {
      return {
        [verb]: done.length,
        requested: targets.length,
        note: 'Some suggestions could not be applied in the editor. Tell the author, reject those with reject_suggestions, and suggest the change again one paragraph at a time.',
      };
    }
    return { [verb]: done.length, requested: targets.length };
  }
}
