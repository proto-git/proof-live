// Voice tool runner: the conversational contract the Gemini Live agent relies on.
// Run with: npx tsx src/tests/voice-tools.test.ts

import { VoiceToolRunner, type VoiceEditorApi } from '../voice/tools.ts';
import type { Mark } from '../formats/marks.ts';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  got      ${a}`);
}

function pendingMark(id: string, quote: string, content: string): Mark {
  return { id, kind: 'replace', by: 'ai:gemini-live', at: '', quote, data: { content, status: 'pending' } } as Mark;
}

interface Harness {
  runner: VoiceToolRunner;
  requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  accepted: string[];
  rejected: string[];
  pending: Mark[];
  selection: { text: string; block: string; from: number; to: number } | null;
  nextResponse: { status: number; body: Record<string, unknown> };
}

function createHarness(): Harness {
  const harness = {
    requests: [],
    accepted: [],
    rejected: [],
    pending: [],
    selection: null,
    nextResponse: { status: 200, body: { success: true, markId: 'm1' } },
  } as unknown as Harness;

  const editor: VoiceEditorApi = {
    getSelectionContext: () => harness.selection,
    getMarkdownSnapshot: () => ({
      content:
        '# Title\n\n<span data-proof="suggestion" data-id="x">Old line</span>\n\n<!-- PROOF\n{"version":2}\n-->\n\n<!-- PROOF:END -->\n',
    }),
    getPendingMarkSuggestions: () => harness.pending,
    markAccept: (id) => {
      harness.accepted.push(id);
      harness.pending = harness.pending.filter((mark) => mark.id !== id);
      return true;
    },
    markReject: (id) => {
      harness.rejected.push(id);
      harness.pending = harness.pending.filter((mark) => mark.id !== id);
      return true;
    },
    navigateToMark: () => true,
  };

  (globalThis as any).window = { setTimeout: () => 0 };
  (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    harness.requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify(harness.nextResponse.body), { status: harness.nextResponse.status });
  };

  harness.runner = new VoiceToolRunner({
    slug: 'doc 1',
    shareToken: 'tok',
    apiBase: 'https://docs.example/api',
    actor: 'ai:gemini-live',
    getAuthorActor: () => 'human:Dan',
    editor,
  });
  return harness;
}

async function run(): Promise<void> {
  // Selection: empty selection steers the model to get_document.
  let h = createHarness();
  assertEqual((await h.runner.run('get_selection', {})).selected, false, 'empty selection reports selected=false');
  h.selection = { text: 'Old line', block: 'Old line in a paragraph', from: 3, to: 11 };
  assertEqual(
    await h.runner.run('get_selection', {}),
    { selected: true, text: 'Old line', surrounding_block: 'Old line in a paragraph' },
    'selection returns text and its block',
  );

  // Document: review metadata is stripped so the model only sees prose.
  assertEqual(await h.runner.run('get_document', {}), { markdown: '# Title\n\nOld line' }, 'get_document strips review metadata');

  // Suggestion: goes through the agent bridge, attributed to the agent, with presence.
  h = createHarness();
  const suggested = await h.runner.run('suggest_replace', { quote: 'Old line', replacement: 'New line' });
  assertEqual(suggested, { ok: true, id: 'm1', status: 'pending author review' }, 'suggest_replace reports pending');
  assertEqual(
    h.requests[0].url,
    'https://docs.example/api/agent/doc%201/ops',
    'ops go to the configured server origin with an encoded slug',
  );
  assertEqual(
    h.requests[0].body,
    { type: 'suggestion.add', kind: 'replace', quote: 'Old line', content: 'New line', by: 'ai:gemini-live' },
    'suggestion payload',
  );
  assertEqual(h.requests[0].headers['X-Agent-Id'], 'gemini-live', 'presence header');
  assertEqual(h.requests[0].headers['x-share-token'], 'tok', 'share token header');

  // "Yes" with no ids accepts everything the agent has pending, across turns,
  // and leaves other people's suggestions alone.
  h.pending = [
    pendingMark('m1', 'Old line', 'New line'),
    pendingMark('earlier-turn', 'Third', 'Fourth'),
    { ...pendingMark('human-1', 'Other', 'Else'), by: 'human:Sam' } as Mark,
  ];
  assertEqual(await h.runner.run('accept_suggestions', {}), { accepted: 2, requested: 2 }, 'accept defaults to all agent suggestions');
  assertEqual(h.accepted, ['m1', 'earlier-turn'], 'other authors were left alone');

  // "Try again": reject latest batch, then the next suggestion starts a new batch.
  h = createHarness();
  await h.runner.run('suggest_replace', { quote: 'Old line', replacement: 'Attempt one' });
  h.pending = [pendingMark('m1', 'Old line', 'Attempt one')];
  h.runner.endBatch();
  assertEqual(await h.runner.run('reject_suggestions', {}), { rejected: 1, requested: 1 }, 'reject defaults to latest batch');
  // Rejection clears the server's copy first, as the author's decision, without agent presence.
  const rejectRequest = h.requests[h.requests.length - 1];
  assertEqual(rejectRequest.body, { type: 'suggestion.reject', markId: 'm1', by: 'human:Dan' }, 'reject op payload');
  assertEqual(rejectRequest.headers['X-Agent-Id'], undefined, 'reject carries no agent presence');
  assertEqual(h.rejected, ['m1'], 'editor reject ran after the server accepted it');
  h.nextResponse = { status: 200, body: { success: true, markId: 'm2' } };
  await h.runner.run('suggest_replace', { quote: 'Old line', replacement: 'Attempt two' });
  h.pending = [pendingMark('m2', 'Old line', 'Attempt two')];
  await h.runner.run('accept_suggestions', {});
  assertEqual(h.accepted, ['m2'], 'new batch replaced the rejected one');

  // Several suggestions in one turn form one batch.
  h = createHarness();
  await h.runner.run('suggest_replace', { quote: 'A', replacement: 'a' });
  h.nextResponse = { status: 200, body: { success: true, markId: 'm2' } };
  await h.runner.run('suggest_delete', { quote: 'B' });
  h.pending = [pendingMark('m1', 'A', 'a'), pendingMark('m2', 'B', '')];
  assertEqual(await h.runner.run('accept_suggestions', {}), { accepted: 2, requested: 2 }, 'batch of two accepted together');

  // A second suggestion on text that already has a pending one is refused, so
  // the model resolves the first instead of stacking marks the editor cannot show.
  h = createHarness();
  h.pending = [pendingMark('m1', 'Old line here', 'Attempt one')];
  const stacked = await h.runner.run('suggest_replace', { quote: 'Old line', replacement: 'Attempt two' });
  assertEqual((stacked as { pending_id?: string }).pending_id, 'm1', 'overlapping suggestion names the pending mark');
  assertEqual(h.requests.length, 0, 'overlapping suggestion made no request');
  assertEqual(await h.runner.run('reject_suggestions', { ids: ['m1'] }), { rejected: 1, requested: 1 }, 'reject clears the way');
  assertEqual(
    await h.runner.run('suggest_replace', { quote: 'Old line', replacement: 'Attempt two' }),
    { ok: true, id: 'm1', status: 'pending author review' },
    'suggestion allowed once the range is free',
  );

  // all=true sweeps everything pending, including other authors' suggestions.
  h = createHarness();
  h.pending = [pendingMark('x', 'A', 'a'), pendingMark('y', 'B', 'b')];
  assertEqual(await h.runner.run('reject_suggestions', { all: true }), { rejected: 2, requested: 2 }, 'all=true rejects everything');

  // If the server refuses a rejection, the editor is left alone so the two cannot diverge.
  // (Each createHarness() re-points the global fetch mock, so scenarios never interleave.)
  h = createHarness();
  h.pending = [pendingMark('z', 'A', 'a')];
  h.nextResponse = { status: 500, body: { success: false, error: 'boom' } };
  assertEqual(await h.runner.run('reject_suggestions', { ids: ['z'] }), { rejected: 0, requested: 1 }, 'server refusal reported');
  assertEqual(h.rejected, [], 'editor untouched when server refuses');

  // Nothing to act on is reported, not thrown.
  h = createHarness();
  assertEqual(
    await h.runner.run('accept_suggestions', {}),
    { accepted: 0, note: 'There were no matching pending suggestions.' },
    'no pending suggestions',
  );

  // A missing quote tells the model how to recover.
  h = createHarness();
  h.nextResponse = { status: 409, body: { success: false, error: 'Suggestion anchor quote not found in document' } };
  const missing = await h.runner.run('suggest_replace', { quote: 'Nope', replacement: 'x' });
  if (!String(missing.error).includes('character for character')) throw new Error('missing quote should coach the model');

  // Other server errors pass through; bad arguments never reach the network.
  h.nextResponse = { status: 429, body: { success: false, error: 'Rate limit exceeded' } };
  assertEqual(await h.runner.run('leave_comment', { quote: 'A', text: 'why?' }), { error: 'Rate limit exceeded' }, 'server error passthrough');
  const before = h.requests.length;
  assertEqual(await h.runner.run('suggest_replace', { quote: 'A' }), { error: 'quote and replacement are required' }, 'argument validation');
  assertEqual(h.requests.length, before, 'invalid call made no request');
  assertEqual(await h.runner.run('nonsense', {}), { error: 'Unknown tool: nonsense' }, 'unknown tool');

  console.log('voice-tools: all assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
