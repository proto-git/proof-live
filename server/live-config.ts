// Gemini Live session configuration. This is the single source of truth for the
// voice agent: the server bakes it into each ephemeral token (so the browser
// cannot change the model, instructions, or tools) and also returns it to the
// client, which must present the same config when it connects.

export const LIVE_AGENT_ACTOR = 'ai:gemini-live';

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';
export const DEFAULT_LIVE_VOICE = 'Kore';

export function getLiveModel(): string {
  return (process.env.GEMINI_LIVE_MODEL || '').trim() || DEFAULT_LIVE_MODEL;
}

export function getLiveVoice(): string {
  return (process.env.GEMINI_LIVE_VOICE || '').trim() || DEFAULT_LIVE_VOICE;
}

const SYSTEM_INSTRUCTION = `You are a voice editing partner working inside a collaborative Markdown document with a human author. You hear them speak and you can see and change the document through tools.

How to work:
- You cannot see the document until you ask. Before responding to any request about the text, call get_selection. If nothing is selected, call get_document. Never ask the author to read text aloud.
- When asked to improve, reword, tighten, or fix text, call suggest_replace with the exact original text as "quote" and your rewrite as "replacement". Never apply changes directly; every change is a suggestion the author accepts or rejects.
- "quote" must be copied character for character from the document or selection, as plain text: leave out Markdown symbols such as #, *, - and >. Keep it as short as the change allows. For several separate changes, make several calls.
- When the author says "this", "here", or "that paragraph", they mean the current selection. Call get_selection again each time, because the selection changes as they work.
- After suggesting, say in one short sentence what you changed and why. Do not read the rewrite aloud unless asked.
- When the author says yes, accept, looks good, or similar, call accept_suggestions. With no ids it accepts every suggestion of yours that is still pending. When they say no, undo, or reject, call reject_suggestions. With no ids it rejects your most recent suggestions.
- Tool results are the truth. Only say a change was made, accepted, or rejected when the tool returned ok or a count above zero. If a tool returns an error or a count of zero, say plainly that it did not work and what you will try instead. Never describe the document from memory: call get_document again before reading it back or confirming what it says.
- "Try again" means reject your last suggestions, then suggest a new version that follows their feedback.
- Use leave_comment for questions, concerns, or notes that are not a concrete text change.

Style:
- Speak briefly, like a colleague at the next desk. One or two sentences unless asked for more.
- Match the register the author asks for. If they want professional and instructional, remove hype, hooks, and filler.
- Stay quiet when the author is thinking aloud or talking to someone else. Do not narrate tool calls.`;

const TOOL_DECLARATIONS = [
  {
    name: 'get_selection',
    description: 'Return the text the author currently has selected in the editor, with the paragraph around it.',
    behavior: 'BLOCKING',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_document',
    description: 'Return the full current Markdown of the document.',
    behavior: 'BLOCKING',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'suggest_replace',
    description: 'Propose replacing existing text with new text as a tracked suggestion the author can accept or reject.',
    behavior: 'BLOCKING',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        quote: { type: 'string', description: 'Exact existing text to replace, copied character for character.' },
        replacement: { type: 'string', description: 'The new text.' },
      },
      required: ['quote', 'replacement'],
    },
  },
  {
    name: 'suggest_insert',
    description: 'Propose inserting new text immediately after an existing anchor passage, as a tracked suggestion.',
    behavior: 'BLOCKING',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        after_quote: { type: 'string', description: 'Exact existing text that the new content should follow.' },
        content: { type: 'string', description: 'The text to insert.' },
      },
      required: ['after_quote', 'content'],
    },
  },
  {
    name: 'suggest_delete',
    description: 'Propose deleting existing text, as a tracked suggestion.',
    behavior: 'BLOCKING',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        quote: { type: 'string', description: 'Exact existing text to delete.' },
      },
      required: ['quote'],
    },
  },
  {
    name: 'leave_comment',
    description: 'Attach a comment to a passage. Use for questions or notes that are not a concrete text change.',
    behavior: 'BLOCKING',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        quote: { type: 'string', description: 'Exact existing text the comment is about.' },
        text: { type: 'string', description: 'The comment.' },
      },
      required: ['quote', 'text'],
    },
  },
  {
    name: 'list_suggestions',
    description: 'List pending suggestions in the document with their ids, authors, and text.',
    behavior: 'BLOCKING',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'accept_suggestions',
    description: 'Accept pending suggestions. With no ids, accepts every pending suggestion you made. Pass all=true to also accept suggestions from other people.',
    behavior: 'BLOCKING',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        all: { type: 'boolean' },
      },
    },
  },
  {
    name: 'reject_suggestions',
    description: 'Reject pending suggestions. With no ids, rejects the suggestions you made most recently. Pass all=true to reject every pending suggestion.',
    behavior: 'BLOCKING',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        all: { type: 'boolean' },
      },
    },
  },
];

export type LiveSessionConfig = Record<string, unknown>;

export function buildLiveSessionConfig(options?: { resumeHandle?: string | null }): LiveSessionConfig {
  const handle = options?.resumeHandle?.trim();
  return {
    responseModalities: ['AUDIO'],
    systemInstruction: SYSTEM_INSTRUCTION,
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: getLiveVoice() } },
    },
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: { silenceDurationMs: 700 },
    },
    // Sessions cap at 15 minutes of audio and connections at roughly 10. Sliding
    // window compression plus resumption lets an editing session run as long as
    // the author wants.
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: handle ? { handle } : {},
  };
}
