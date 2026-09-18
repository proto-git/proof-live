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

  constructor(private readonly context: VoiceToolContext) {}

  // The session calls this when the author starts a new turn. The next
  // suggestion then starts a fresh batch rather than extending the old one.
  endBatch(): void {
    this.batchOpen = false;
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
        // "# Old title" -> "# New title" means the text changes and the block
        // stays what it is, so the same marker comes off the replacement too.
        const contentPrefix = stripBlockPrefix(content);
        if (stripped.prefix && contentPrefix.prefix === stripped.prefix) content = contentPrefix.text;
        return this.addSuggestion({ kind: 'replace', quote, content });
      }

      case 'suggest_insert': {
        const quote = stripBlockPrefix(asString(args.after_quote)).text;
        const content = asString(args.content);
        if (!quote || !content) return { error: 'after_quote and content are required' };
        return this.addSuggestion({ kind: 'insert', quote, content });
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

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  private async addSuggestion(op: { kind: 'replace' | 'insert' | 'delete'; quote: string; content?: string }): Promise<ToolResult> {
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
    if (result.markId) this.recentSuggestionIds.push(result.markId);
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

    if (targets.length === 0) return { [verb]: 0, note: 'There were no matching pending suggestions.' };

    const done: string[] = [];
    for (const id of targets) {
      if (pending.has(id) && (await apply(id))) done.push(id);
    }
    this.recentSuggestionIds = this.recentSuggestionIds.filter((id) => !done.includes(id));
    return { [verb]: done.length, requested: targets.length };
  }
}
