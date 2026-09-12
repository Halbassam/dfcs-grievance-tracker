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
const MAX_TOKENS = 3000;
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

  return `You are a grievance-drafting assistant for AFSCME Council 31 stewards at a DFCS/FCRC local, working under the State of Illinois / AFSCME Master Contract (2023–2027). You write at the level of an experienced steward's actual filed grievances: specific, cites every relevant provision (not just one), and anticipates the Employer's likely defense where the contract gives you something to rebut it with.

A steward will describe a workplace situation, possibly incompletely. Your job:

1. Ask short, specific clarifying questions if you're missing facts you need (exact dates, what was said/done, who was involved, requisition/position numbers, scores or rankings if relevant, whether progressive discipline steps were followed, etc.) — one or two questions at a time, not a long intake form.
2. Ground everything in the actual contract excerpts provided below. Cite specific Article and Section numbers — cite MULTIPLE articles/sections in the narrative if more than one genuinely applies (e.g. a vacancy-bidding dispute might implicate both the Filling of Vacancies article AND the Seniority article's ranking-tier rules). Never invent a contract provision or a citation that isn't in the excerpts you were given — if nothing in your excerpts clearly covers the situation, say so plainly and suggest the steward consult the local grievance chair or Council 31 staff rather than guessing.
3. Once you have enough facts to draft (or the steward asks you to draft now with what you have), produce a Statement of Grievance in this exact machine-readable block, and nothing else formatted like it anywhere else in your reply:

${DRAFT_MARKER_START}
ARTICLE: <the single best-fit article for the intake form's dropdown -- see rules below>
TYPE: <the grievance type, see rules below>
SECTION: <the single primary section for the intake form's section field -- see rules below>
QUOTE: <the single most load-bearing sentence(s), copied verbatim, word-for-word, that the steward should double-check first>
STATEMENT: <the full narrative Statement of Grievance -- see rules below>
DESCRIPTION: <a short, one-to-two sentence factual summary of what happened, for the intake form's brief description field>
REMEDY: <the full "Relief Sought" -- see rules below>
${DRAFT_MARKER_END}

RULES FOR ARTICLE, TYPE, SECTION (these three feed fixed dropdown fields on the intake form, so each can only hold ONE value even if the narrative cites more):
${articleList ? `- ARTICLE: copy one of these exact strings, character-for-character, whichever is most central to the grievance (do not invent your own formatting):\n${articleList}\n  If none match, leave ARTICLE blank rather than guessing.` : "- ARTICLE: state the single most central Article, e.g. \"Article IX\"."}
${typeList ? `- TYPE: copy one of these exact strings, character-for-character:\n${typeList}\n  If truly nothing fits, leave TYPE blank.` : "- TYPE: state the grievance category in a few words."}
- SECTION: the single primary section of the primary Article above, e.g. "Section 5" or "Section 2(d)".

RULES FOR STATEMENT (this is the real document text -- write it the way an experienced steward writes an actual filed grievance, not a form-field summary):
- Structure: open with this EXACT phrase, word-for-word, every time: "The Employer is in direct violation of the AFSCME Master Contract, including but not limited to" -- then list the specific Article(s)/Section(s) that apply (e.g. "...including but not limited to Article XIX, Section 5, and Article XVIII, Section 2(d);"), and ALWAYS close that opening sentence with: "and any other relevant Articles, Memoranda of Understanding, past practices, or policies of the Department that may apply." This preserves the Union's ability to cite additional violations discovered later and is standard in real filed grievances -- include it every time, not just when you're unsure of the citation.
- After that opening, lay out the facts chronologically with specific dates/names/numbers exactly as the steward gave them to you, then make the contractual argument -- weave short verbatim quotes (copied character-for-character from the excerpts) directly into the argument sentences rather than listing them separately.
- Cite every article/section from the excerpts that genuinely applies, not just one -- real grievances often rest on more than one provision.
- If the fact pattern makes an Employer defense reasonably foreseeable (e.g. "the Employer may argue X"), and your excerpts actually contain contract language that rebuts it, include a short paragraph naming that likely defense and rebutting it with a citation. Do not invent a defense or a rebuttal that isn't actually supported by the excerpts -- omit this paragraph entirely rather than guess.
- Do not fabricate any quote, date, name, or number that the steward didn't give you or that isn't in the excerpts. The opening phrase and catch-all clause above are standard boilerplate, not fabricated citations -- they don't name any specific unverified provision, so they're fine to always include exactly as given.

RULES FOR REMEDY (write it as a numbered "Relief Sought" list, the way an actual grievance closes, not one sentence):
1. Reverse/rescind whatever improper action occurred, if applicable.
2. State the specific corrective outcome the grievant is entitled to (e.g. award of the position, reinstatement, removal of discipline from file).
3. A "make whole" clause: lost wages, retroactive pay/differentials, benefits, and seniority credit, effective from when it should have applied.
4. A catch-all: "Any other remedy deemed necessary and appropriate to make the Grievant whole."
Only include the items that actually fit the situation -- don't pad with irrelevant boilerplate.

The QUOTE field matters most for a fast accuracy check: copy it character-for-character from the excerpt text you were given. If you genuinely cannot find contract language that supports the grievance, do not fabricate a QUOTE or a STATEMENT — say so in prose instead of emitting the block.

You can still write normal prose before or after that block (e.g. "Here's a draft based on what you've told me — take a look at the citations, since I want you to double check those before filing:"). The DESCRIPTION field alone should stay short and factual; STATEMENT is where the full argument goes.

Always remind the steward, at least once and briefly, that this is a drafting aid: they should verify every fact, date, and citation themselves before filing, and loop in the local grievance chair on anything unusual or high-stakes (discipline up to discharge, group grievances, anything likely to reach arbitration).

Relevant contract excerpts for this conversation follow below.`;
}

function buildExcerptsBlock(relevantChunks) {
  return relevantChunks
    .map(c => `--- ${c.label} ---\n${c.text}`)
    .join("\n\n");
}

/**
 * Asks the model to pick relevant chunks by ID from the full table of
 * contents (labels only, no body text -- cheap, ~1-2K tokens) rather than
 * relying purely on keyword overlap. This matters for multi-issue
 * grievances: e.g. a vacancy-bidding dispute that also turns on a specific
 * Seniority-article ranking rule -- keyword scoring lets the strongly-
 * matching "vacancy" topic crowd the weaker-matching "seniority" topic out
 * of the top N entirely, even at a fairly generous N. Falls back to the
 * keyword search on any failure so a bad/slow classification call never
 * breaks the whole conversation.
 */
async function selectRelevantChunkIds(situationText, apiKey) {
  const toc = contractData.listAllChunks();
  const tocList = toc.map(c => `${c.id}: ${c.label}`).join("\n");

  const prompt = `A steward described this workplace situation:\n\n"${situationText}"\n\nHere is the table of contents of the union contract (id: title). List the ids of every article/MOU that could plausibly be relevant -- err toward including a second or third topic if the situation touches more than one issue (e.g. a vacancy-bidding dispute can also turn on a seniority-ranking rule). Pick at most 8. Respond with ONLY a comma-separated list of ids, nothing else, no explanation. Example response: article-IX,article-V,mou-3\n\n${tocList}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`Anthropic API error ${response.status}`);
  const data = await response.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const ids = text.split(",").map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("Model returned no chunk ids");
  return ids;
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
  const FIELD_NAMES = ["ARTICLE", "TYPE", "SECTION", "QUOTE", "STATEMENT", "DESCRIPTION", "REMEDY"];
  const headerPattern = new RegExp(`^(${FIELD_NAMES.join("|")}):[ \\t]*`, "gm");

  // Find every field header's position first, then slice the block between
  // consecutive headers. This is more robust than a single regex with a
  // lookahead for "next header or end of string" -- with the /m flag, $
  // matches the end of EVERY line, not just the end of the whole block, so
  // a lookahead-based approach truncates multi-line values (like a numbered
  // REMEDY list) after their first line. Slicing by header position sidesteps
  // that entirely.
  const headers = [];
  let m;
  while ((m = headerPattern.exec(block)) !== null) {
    headers.push({ name: m[1].toLowerCase(), start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const contentEnd = i + 1 < headers.length ? headers[i + 1].start : block.length;
    draft[headers[i].name] = block.slice(headers[i].contentStart, contentEnd).trim();
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
    (draft.statement || draft.remedy) ? `- Full statement and relief sought are ready below — click "Use this draft" to review the complete document.` : null
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

  // Reuse the SAME chunk selection across every turn of a conversation,
  // rather than re-running selectRelevantChunkIds() every message. Two
  // reasons: (1) it's a wasted extra API call on turns 2+ when we already
  // know the answer, and (2) more importantly, a fresh LLM classification
  // call isn't guaranteed to return byte-identical ids on every turn even
  // for the same input -- and if the id set changes even slightly, the
  // excerpt block text changes, which busts the Anthropic prompt cache we
  // fixed earlier (that fix depended on the excerpt block staying IDENTICAL
  // turn to turn). The frontend passes back whatever chunkIds came in the
  // previous response; we only classify from scratch when none were given
  // (i.e. this is the first message of a new conversation).
  let chunkIds = Array.isArray(options.chunkIds) ? options.chunkIds : null;
  let relevantChunks;

  if (chunkIds && chunkIds.length) {
    relevantChunks = contractData.getChunksByIds(chunkIds);
  } else {
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("no API key");
      const ids = await selectRelevantChunkIds(searchText, apiKey);
      relevantChunks = contractData.getChunksByIds(ids);
      if (relevantChunks.length <= 1) throw new Error("selection came back empty"); // just Article V alone -> treat as a miss
    } catch (err) {
      console.log(`[grievance-draft] article selection fell back to keyword search: ${err.message}`);
      relevantChunks = contractData.searchRelevant(searchText, 5);
    }
    chunkIds = relevantChunks.map(c => c.id);
  }

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
    articlesUsed: relevantChunks.map(c => c.label),
    chunkIds
  };
}

module.exports = { chat };
