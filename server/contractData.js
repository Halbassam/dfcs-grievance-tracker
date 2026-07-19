/**
 * Loads the parsed Master Contract (articles + memoranda/side letters) into
 * memory once at startup, and provides a lightweight keyword-relevance
 * search so the grievance-drafting bot only has to send a handful of
 * relevant excerpts to the model instead of the entire ~380K-character
 * contract on every turn.
 *
 * No embeddings, no external service — just term-frequency scoring with a
 * basic inverse-document-frequency weighting. That's plenty for a ~50-chunk
 * corpus and keeps this dependency-free (only "pg" is in package.json).
 *
 * To update the contract text in the future: regenerate
 * server/data/contract.json and server/data/mous.json and redeploy. (Ask
 * Claude to do this again from a new contract PDF — the parsing script
 * isn't part of this app, it's a one-time extraction step.)
 */

const fs = require("fs");
const path = require("path");

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","by","with","is","was",
  "were","be","been","being","this","that","these","those","it","its","as",
  "at","from","but","not","no","if","then","than","so","such","any","all",
  "shall","may","will","would","should","must","can","could","have","has",
  "had","do","does","did","he","she","they","them","his","her","their",
  "employee","employer","union","agreement","article","section","i","ii",
  "iii","which","who","whom","what","when","where","why","how","up","out",
  "into","over","under","again","further","because","during","before",
  "after","above","below","between","each","other","same","most","own",
  "only","also","upon","within","without","per","about","my","me","i'm",
  "we","us","our"
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z'-]{1,}/g) || [])
    .filter(w => !STOPWORDS.has(w) && w.length > 2);
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

let CHUNKS = null; // built lazily
let DOC_FREQ = null;
let N = 0;

function loadChunks() {
  if (CHUNKS) return CHUNKS;

  const contractPath = path.join(__dirname, "data", "contract.json");
  const mouPath = path.join(__dirname, "data", "mous.json");

  const chunks = [];

  try {
    const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
    for (const a of contract.articles || []) {
      chunks.push({
        id: `article-${a.article}`,
        label: `Article ${a.article}${a.title ? " — " + a.title : ""}`,
        text: a.text,
        kind: "article"
      });
    }
  } catch (err) {
    console.error("[contractData] Could not load contract.json:", err.message);
  }

  try {
    const mous = JSON.parse(fs.readFileSync(mouPath, "utf8"));
    (mous.memoranda_and_side_letters || []).forEach((m, i) => {
      let label = m.title || `Memorandum of Understanding ${i + 1}`;
      if (label.length > 66) label = label.slice(0, 63).trim() + "…";
      chunks.push({
        id: `mou-${i}`,
        label,
        text: m.text,
        kind: "mou"
      });
    });
  } catch (err) {
    console.error("[contractData] Could not load mous.json:", err.message);
  }

  chunks.forEach(c => { c.tokens = tokenize(c.text); c.tf = termFreq(c.tokens); });

  N = chunks.length;
  DOC_FREQ = new Map();
  for (const c of chunks) {
    for (const term of c.tf.keys()) {
      DOC_FREQ.set(term, (DOC_FREQ.get(term) || 0) + 1);
    }
  }

  CHUNKS = chunks;
  return CHUNKS;
}

function idf(term) {
  const df = DOC_FREQ.get(term) || 0;
  if (!df) return 0;
  return Math.log(1 + N / df);
}

/**
 * Returns the top N most relevant chunks for the given free-text query,
 * always including Article V (Grievance Procedure) since it governs the
 * filing process itself regardless of subject matter.
 */
function searchRelevant(queryText, topN = 5) {
  const chunks = loadChunks();
  const qTokens = tokenize(queryText);
  const qTf = termFreq(qTokens);

  const scored = chunks.map(c => {
    let score = 0;
    for (const [term, qCount] of qTf.entries()) {
      const cCount = c.tf.get(term) || 0;
      if (!cCount) continue;
      score += Math.sqrt(cCount) * Math.sqrt(qCount) * idf(term);
    }
    // Mild length penalty so very long articles don't win purely on bulk.
    score = score / (1 + Math.log(1 + c.text.length / 2000));
    return { chunk: c, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const alwaysInclude = chunks.find(c => c.id === "article-V");
  const results = [];
  const seen = new Set();

  if (alwaysInclude) {
    results.push(alwaysInclude);
    seen.add(alwaysInclude.id);
  }

  for (const { chunk, score } of scored) {
    if (results.length >= topN) break;
    if (seen.has(chunk.id)) continue;
    if (score <= 0 && results.length > 0) continue; // don't pad with zero-relevance chunks
    results.push(chunk);
    seen.add(chunk.id);
  }

  return results;
}

function listArticleTitles() {
  const chunks = loadChunks();
  return chunks
    .filter(c => c.kind === "article")
    .map(c => c.label);
}

module.exports = { searchRelevant, listArticleTitles };
