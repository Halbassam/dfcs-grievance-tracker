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

const MODEL = "claude-haiku-4-5-20251001"; // $1/$5 per million tokens vs Sonnet's $3/$15 -- ~3x cheaper
const MAX_TOKENS = 2000;
const ANTHROPIC_VERSION = "2023-06-01";

const DRAFT_MARKER_START = "===GRIEVANCE_DRAFT===";
const DRAFT_MARKER_END = "===END===";

function buildInstructions(articleOptions, grievanceTypeOptions) {
  const articleList = (articleOptions && articleOptions.length)
    ? articleOptions.map(a => `- ${a}`).join("\n")
    : null;
  const typeList = (grievanceTypeOptions && grievanceTypeOptions.length)
    ? grievanceTypeOptions.map(t => `- ${t}`).join("\n")
    : null;

  return `You are a grievance-drafting assistant for AFSCME Council 31 stewards at a DFCS/FCRC local, working under the State of Illinois / AFSCME Master Contract (2023–2027).

A steward will describe a workplace situation, possibly incompletely. Your job:

1. Ask short, specific clarifying questions if you're missing facts you need (dates, what was said/done, who was involved, whether progressive discipline steps were followed, whether this is a pattern, etc.) — one or two questions at a time, not a long intake form.
2. Ground everything in the actual contract excerpts provided below. Cite specific Article and Section numbers. Never invent a contract provision or a citation that isn't in the excerpts you were given — if nothing in your excerpts clearly covers the situation, say so plainly and suggest the steward consult the local grievance chair or Council 31 staff rather than guessing.
3. Once you have enough facts to draft (or the steward asks you to draft now with what you have), produce a Statement of Grievance in this exact machine-readable block, and nothing else formatted like it anywhere else in your reply:

${DRAFT_MARKER_START}
ARTICLE: <e.g. Article IX>
TYPE: <the grievance type, see rules below>
SECTION: <e.g. Sec. 2 — Progressive Discipline>
QUOTE: <the exact sentence(s) from the excerpt below that support this grievance, copied verbatim, word-for-word — this is what the steward checks against the real contract, so do not paraphrase it>
DESCRIPTION: <a factual, concise statement of what happened — who, what, when, where>
REMEDY: <the specific remedy/relief being sought>
${DRAFT_MARKER_END}

${articleList ? `For ARTICLE, you MUST copy one of these exact strings, character-for-character, from this local's own dropdown list (do not invent your own formatting even if it looks different from "Article IX" style):\n${articleList}\n\nIf none of these options match what the contract excerpts actually cover, leave ARTICLE blank rather than guessing.\n` : ""}
${typeList ? `For TYPE, you MUST copy one of these exact strings, character-for-character, from this local's own dropdown list:\n${typeList}\n\nPick whichever one best fits the situation. If truly nothing fits, leave TYPE blank rather than guessing.\n` : ""}
The QUOTE field matters most for accuracy: copy it character-for-character from the excerpt text you were given, not from memory and not paraphrased. If more than one sentence is needed for the quote to make sense, include all of them verbatim. If you genuinely cannot find contract language that supports the grievance, do not fabricate a QUOTE — say so in prose instead of emitting the block.

You can still write normal prose before or after that block (e.g. "Here's a draft based on what you've told me — take a look at the Article and Section, since I want you to double check those before filing:"). Keep the DESCRIPTION and REMEDY factual and free of legal argument — that block is what gets copied into the intake form.

Always remind the steward, at least once and briefly, that this is a drafting aid: they should verify facts, dates, and citations themselves before filing, and loop in the local grievance chair on anything unusual or high-stakes (discipline up to discharge, group grievances, anything likely to reach arbitration).

Relevant contract excerpts for this conversation follow below.`;
}

function buildExcerptsBlock(relevantChunks) {
  return relevantChunks
    .map(c => `--- ${c.label} ---\n${c.text}`)
    .join("\n\n");
}

async function callAnthropic(instructions, excerptsBlock, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set on the server. Add it in Render → Environment, then redeploy."
    );
  }

  // Two system blocks: the short per-request instructions, then the large
  // contract-excerpt text marked cacheable. Plain 5-minute (default) TTL --
  // at roughly one grievance a day, sessions are hours apart, so the 1-hour
  // cache's cross-session reuse never really pays off and its higher write
  // premium (2x base vs 1.25x) would just be wasted. The 5-minute window
  // still covers what actually matters: the handful of back-and-forth turns
  // within a single drafting session, which happen minutes apart.
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
      system: [
        { type: "text", text: instructions },
        { type: "text", text: excerptsBlock, cache_control: { type: "ephemeral" } }
      ],
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

  return { text, usage: data.usage || null };
}

/** Pulls out the machine-readable draft block, if the reply included one. */
function extractDraft(replyText) {
  const start = replyText.indexOf(DRAFT_MARKER_START);
  const end = replyText.indexOf(DRAFT_MARKER_END);
  if (start === -1 || end === -1 || end < start) return null;

  const block = replyText.slice(start + DRAFT_MARKER_START.length, end);
  const draft = {};
  const fieldPattern = /^(ARTICLE|TYPE|SECTION|QUOTE|DESCRIPTION|REMEDY):\s*([\s\S]*?)(?=\n[A-Z]+:|$)/gm;
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
    draft.type ? `- **Grievance type:** ${draft.type}` : null,
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
async function chat(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("At least one message is required.");
  }

  const articleOptions = Array.isArray(options.articleOptions) ? options.articleOptions : [];
  const grievanceTypeOptions = Array.isArray(options.grievanceTypeOptions) ? options.grievanceTypeOptions : [];

  // Base article selection on the FIRST user message only, not the whole
  // growing conversation. Two reasons: (1) that's where the actual fact
  // pattern lives -- later turns are usually the steward answering the
  // bot's own clarifying questions, not introducing a new contract issue,
  // and (2) it keeps the excerpt set IDENTICAL turn to turn, which is what
  // makes the cache actually hit. Recomputing from the full growing
  // conversation on every turn (the previous behavior) changed the excerpt
  // set almost every message, which busted the cache nearly every time --
  // that's why turns were showing cache_write instead of cache_read even
  // within one back-and-forth.
  const firstUserMessage = messages.find(m => m.role === "user");
  const searchText = firstUserMessage ? firstUserMessage.content : "";

  const relevantChunks = contractData.searchRelevant(searchText, 5);
  const instructions = buildInstructions(articleOptions, grievanceTypeOptions);
  const excerptsBlock = buildExcerptsBlock(relevantChunks);

  const { text: rawReply, usage } = await callAnthropic(instructions, excerptsBlock, messages);
  if (usage) {
    console.log(
      `[grievance-draft] tokens — input:${usage.input_tokens} cache_write:${usage.cache_creation_input_tokens || 0} cache_read:${usage.cache_read_input_tokens || 0} output:${usage.output_tokens}`
    );
  }
  const extracted = extractDraft(rawReply);

  return {
    reply: extracted ? extracted.displayText : rawReply,
    draft: extracted ? extracted.draft : null,
    articlesUsed: relevantChunks.map(c => c.label)
  };
}

module.exports = { chat };
