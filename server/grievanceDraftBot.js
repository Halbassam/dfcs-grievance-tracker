/**
 * Grievance-drafting chatbot.
 *
 * Takes the running chat conversation, pulls the most relevant contract
 * articles/MOUs via contractData.searchRelevant(), and calls the Anthropic
 * Messages API with that context baked into the system prompt.
 *
 * Requires ANTHROPIC_API_KEY to be set in the environment (Render →
 * Environment → Add Environment Variable). Get a key at
 * https://console.anthropic.com/settings/keys
 */

const contractData = require("./contractData");

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2000;
const ANTHROPIC_VERSION = "2023-06-01";

const DRAFT_MARKER_START = "===GRIEVANCE_DRAFT===";
const DRAFT_MARKER_END = "===END===";

function buildSystemPrompt(relevantChunks) {
  const excerpts = relevantChunks
    .map(c => `--- ${c.label} ---\n${c.text}`)
    .join("\n\n");

  return `You are a grievance-drafting assistant for AFSCME Council 31 stewards at a DFCS/FCRC local, working under the State of Illinois / AFSCME Master Contract (2023–2027).

A steward will describe a workplace situation, possibly incompletely. Your job:

1. Ask short, specific clarifying questions if you're missing facts you need (dates, what was said/done, who was involved, whether progressive discipline steps were followed, whether this is a pattern, etc.) — one or two questions at a time, not a long intake form.
2. Ground everything in the actual contract excerpts provided below. Cite specific Article and Section numbers. Never invent a contract provision or a citation that isn't in the excerpts you were given — if nothing in your excerpts clearly covers the situation, say so plainly and suggest the steward consult the local grievance chair or Council 31 staff rather than guessing.
3. Once you have enough facts to draft (or the steward asks you to draft now with what you have), produce a Statement of Grievance in this exact machine-readable block, and nothing else formatted like it anywhere else in your reply:

${DRAFT_MARKER_START}
ARTICLE: <e.g. Article IX>
SECTION: <e.g. Sec. 2 — Progressive Discipline>
QUOTE: <the exact sentence(s) from the excerpt below that support this grievance, copied verbatim, word-for-word — this is what the steward checks against the real contract, so do not paraphrase it>
DESCRIPTION: <a factual, concise statement of what happened — who, what, when, where>
REMEDY: <the specific remedy/relief being sought>
${DRAFT_MARKER_END}

The QUOTE field matters most for accuracy: copy it character-for-character from the excerpt text you were given, not from memory and not paraphrased. If more than one sentence is needed for the quote to make sense, include all of them verbatim. If you genuinely cannot find contract language that supports the grievance, do not fabricate a QUOTE — say so in prose instead of emitting the block.

You can still write normal prose before or after that block (e.g. "Here's a draft based on what you've told me — take a look at the Article and Section, since I want you to double check those before filing:"). Keep the DESCRIPTION and REMEDY factual and free of legal argument — that block is what gets copied into the intake form.

Always remind the steward, at least once and briefly, that this is a drafting aid: they should verify facts, dates, and citations themselves before filing, and loop in the local grievance chair on anything unusual or high-stakes (discipline up to discharge, group grievances, anything likely to reach arbitration).

Relevant contract excerpts for this conversation:

${excerpts}`;
}

async function callAnthropic(systemPrompt, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set on the server. Add it in Render → Environment, then redeploy."
    );
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");

  return text;
}

/** Pulls out the machine-readable draft block, if the reply included one. */
function extractDraft(replyText) {
  const start = replyText.indexOf(DRAFT_MARKER_START);
  const end = replyText.indexOf(DRAFT_MARKER_END);
  if (start === -1 || end === -1 || end < start) return null;

  const block = replyText.slice(start + DRAFT_MARKER_START.length, end);
  const draft = {};
  const fieldPattern = /^(ARTICLE|SECTION|QUOTE|DESCRIPTION|REMEDY):\s*([\s\S]*?)(?=\n[A-Z]+:|$)/gm;
  let match;
  while ((match = fieldPattern.exec(block)) !== null) {
    draft[match[1].toLowerCase()] = match[2].trim();
  }

  // Strip the machine-readable block out of what's shown as prose, replacing
  // it with a short human-readable summary so the chat transcript stays
  // readable even before the "Use this draft" button is wired up visually.
  const displayText =
    replyText.slice(0, start).trim() +
    (replyText.slice(0, start).trim() ? "\n\n" : "") +
    formatDraftForDisplay(draft) +
    "\n\n" +
    replyText.slice(end + DRAFT_MARKER_END.length).trim();

  return { draft, displayText: displayText.trim() };
}

function formatDraftForDisplay(draft) {
  return [
    "**Draft Statement of Grievance**",
    draft.article ? `- **CBA article:** ${draft.article}` : null,
    draft.section ? `- **Section:** ${draft.section}` : null,
    draft.quote ? `- **Contract language (verbatim, verify against the actual contract):** "${draft.quote}"` : null,
    draft.description ? `- **Description:** ${draft.description}` : null,
    draft.remedy ? `- **Remedy sought:** ${draft.remedy}` : null
  ].filter(Boolean).join("\n");
}

/**
 * messages: [{ role: "user"|"assistant", content: string }, ...]
 * Returns { reply, draft, articlesUsed }
 */
async function chat(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("At least one message is required.");
  }

  const userText = messages
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join("\n");

  const relevantChunks = contractData.searchRelevant(userText, 7);
  const systemPrompt = buildSystemPrompt(relevantChunks);

  const rawReply = await callAnthropic(systemPrompt, messages);
  const extracted = extractDraft(rawReply);

  return {
    reply: extracted ? extracted.displayText : rawReply,
    draft: extracted ? extracted.draft : null,
    articlesUsed: relevantChunks.map(c => c.label)
  };
}

module.exports = { chat };
