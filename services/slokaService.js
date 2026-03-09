// services/slokaService.js
const fs = require("fs");
const path = require("path");

const LIBRARY_PATH = path.join(__dirname, "slokaLibrary.json");

function loadLibrary() {
  return JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf8"));
}

/**
 * Scores a sloka against the visual analysis context.
 * Returns the best matching sloka from the curated library.
 */
function selectSloka(visualAnalysis, metadata) {
  const slokas = loadLibrary();

  // Build a context bag of words from visual analysis + metadata
  const contextWords = [
    ...(visualAnalysis.dominant_elements || []),
    visualAnalysis.location_type || "",
    visualAnalysis.mood || "",
    visualAnalysis.human_activity || "",
    visualAnalysis.sky_conditions || "",
    visualAnalysis.water_presence ? "lake water reflection" : "",
    ...(visualAnalysis.specific_visual_details || []),
    metadata?.personal_reflection || "",
    metadata?.intention || "",
  ]
    .join(" ")
    .toLowerCase();

  // Score each sloka by theme overlap
  const scored = slokas.map((sloka) => {
    const score = sloka.themes.reduce((acc, theme) => {
      return acc + (contextWords.includes(theme.toLowerCase()) ? 1 : 0);
    }, 0);
    return { sloka, score };
  });

  // Sort descending by score; fall back to bg_6_29 (oneness/non-duality) if all scores are 0
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0].score > 0 ? scored[0].sloka : slokas.find(s => s.id === "bg_6_29") || slokas[0];

  return best;
}

/**
 * Formats a sloka into a markdown block for injection into the prompt.
 */
function formatSlokaForPrompt(sloka) {
  return `
Use EXACTLY this canonical sloka — do not alter Sanskrit, transliteration, meaning, or reference:

Sanskrit:
${sloka.sanskrit}

Transliteration:
${sloka.transliteration}

Meaning:
${sloka.meaning}

Reference: ${sloka.reference}

Write a short paragraph (3–5 sentences) explaining why this verse resonates with this specific journey.
Do not quote or restate the sloka in the explanation paragraph — only reflect on its relevance.
`;
}

module.exports = { selectSloka, formatSlokaForPrompt };
