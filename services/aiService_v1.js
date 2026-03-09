const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ─── Visual Analysis ──────────────────────────────────────────────────────────
/**
 * Analyzes images and returns structured factual JSON.
 * Enhanced to extract location-identifying visual clues
 * (architecture style, prayer flag type, vegetation, landmarks).
 */
async function analyzeImages(images) {
  const response = await openai.responses.create({
    model: "gpt-4o",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
Analyze the attached travel images objectively. Be precise and factual — no narrative.

Return ONLY valid JSON in this exact structure:

{
  "location_type": "e.g. high-altitude lake, monastery courtyard, mountain pass, temple complex",
  "dominant_elements": ["lake", "snow peaks", "pilgrims", "prayer flags", ...],
  "notable_mountains": "Name if identifiable, or describe shape/profile",
  "water_presence": true/false,
  "water_description": "e.g. turquoise glacial lake, river, none",
  "sky_conditions": "e.g. clear blue, overcast, golden hour, dramatic cloud formation",
  "human_activity": "e.g. pilgrims circumambulating, monks in ceremony, solo traveler, none",
  "mood": "e.g. vast and still, devotional, austere, celebratory",
  "architecture_clues": "e.g. Tibetan gompa, Hindu temple shikhara, white stupa, none",
  "prayer_flags": "e.g. Tibetan lungta (horizontal), Nepali style, none",
  "vegetation": "e.g. high-altitude scrub, rhododendron forest, barren plateau, pine forest",
  "estimated_altitude_clue": "e.g. sparse vegetation + snow line suggests 4500m+, lush forest suggests below 2500m",
  "region_inference": "Best guess at region based purely on visual evidence: e.g. Tibetan Plateau, Nepali Himalaya, Indian Himalaya, unclear",
  "landmark_identification": "If you can identify a specific well-known landmark, name it confidently. e.g. Potala Palace Lhasa, Boudhanath Stupa Kathmandu, Kedarnath Temple, Mount Everest, etc. If not recognizable, write 'not identified'.",
  "specific_visual_details": [
    "detail 1 — be specific: colors, textures, formations",
    "detail 2",
    "detail 3"
  ]
}

Rules:
- If something is not visible, write "not visible" or false — do NOT guess.
- "region_inference" should be your honest best guess based on architecture, flags, terrain, and vegetation ONLY.
- "landmark_identification": be confident if you recognise it — Potala Palace, Boudhanath, major Himalayan peaks etc. are fine to name. If unsure, write "not identified".
`.trim(),
          },
          ...images.map((img) => ({
            type: "input_image",
            image_url: `data:image/jpeg;base64,${img.base64}`,
          })),
        ],
      },
    ],
  });

  const cleaned = response.output_text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(cleaned);
}

// ─── Blog Generation ──────────────────────────────────────────────────────────
/**
 * Generates a structured travel blog post.
 *
 * @param {Array}       images          - Base64 image payloads
 * @param {string}      tripName        - Raw folder name (for reference only)
 * @param {object|null} metadata        - metadata.json contents
 * @param {string[]}    existingPosts   - Slugs of existing posts (for internal linking)
 * @param {object}      visualAnalysis  - Output of analyzeImages()
 * @param {object|null} primaryExif     - Best EXIF record (dateTaken, lat, lon, altitude)
 * @param {string|null} resolvedLocation - GPS reverse-geocoded or context-derived location
 * @param {object}      tripContext     - Output of buildTripContext() from tripParser.js
 */
async function generateTravelBlog(
  images,
  tripName,
  metadata,
  existingPosts,
  visualAnalysis,
  primaryExif,
  resolvedLocation,
  tripContext = {}
) {
  if (!primaryExif) {
    console.log("ℹ️  No EXIF data — relying on tripContext + visual analysis.");
  }

  // ── Determine location confidence level for prompt instructions ────────────
  const hasReliableLocation =
    resolvedLocation &&
    !/^Trip-\d{4}-\d{2}-\d{2}$/i.test(resolvedLocation) &&
    resolvedLocation !== "Unknown";

  // Use landmark identification as a strong location signal if GPS/context unavailable
  const landmarkId = visualAnalysis?.landmark_identification;
  const hasIdentifiedLandmark = landmarkId && landmarkId !== "not identified" && landmarkId !== "not visible";

  const locationInstruction = hasReliableLocation
    ? `The confirmed location is: ${resolvedLocation}. Use this in the narrative. Do not invent a different place.`
    : hasIdentifiedLandmark
    ? `The landmark in these images has been identified as: ${landmarkId}. Use this as the location — name it explicitly in the narrative and title. This is visually confirmed, not guessed.`
    : tripContext.location
    ? `The most likely location is: ${tripContext.location} (derived from folder name / user input, not GPS-verified). Write as if this is the location, but avoid over-specific claims you cannot verify from the images.`
    : `Location is unknown. Do NOT invent a place name. Instead, describe the environment precisely using only what is visible: terrain type, altitude clues, sky, vegetation, and any cultural markers from the visual analysis. Write "somewhere in the high Himalayas" or similar honest phrasing if needed.`;

  // ── Date instruction ───────────────────────────────────────────────────────
  const dateInstruction = primaryExif?.dateTaken
    ? `The confirmed date is ${primaryExif.dateTaken.toISOString().slice(0, 10)}. Use this year explicitly in the narrative.`
    : tripContext.year
    ? `The year is approximately ${tripContext.year}${tripContext.month ? `, month ${tripContext.month}` : ""}. Use this in the narrative.`
    : `The date is unknown. Do not invent a specific year. Use vague phrasing like "one autumn" or "during the monsoon clearance" based on sky/vegetation clues.`;

  // ── Personal context ───────────────────────────────────────────────────────
  const metadataText = metadata
    ? `
Trip Metadata (user-provided — treat as ground truth):
- Location: ${metadata.location || "not specified"}
- Year: ${metadata.year || "not specified"}
- Personal Reflection: ${metadata.personal_reflection || "not specified"}
- Physical Challenge: ${metadata.physical_challenge || "not specified"}
- Intention: ${metadata.intention || "not specified"}
`.trim()
    : tripContext.note
    ? `User note: "${tripContext.note}"`
    : "No personal metadata provided.";

  const response = await openai.responses.create({
    model: "gpt-4o",
    max_output_tokens: 4096,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
═══════════════════════════════════════════════════
⚠️  WORD COUNT REQUIREMENT — READ THIS FIRST
═══════════════════════════════════════════════════

The markdown_content field MUST contain between 950 and 1,100 words.
This is a hard requirement. Short posts will be rejected and the user notified.

MINIMUM words per section — you must meet ALL of these:
- Introduction – Why This Journey:       150 words minimum
- The Landscape & Physical Experience:   200 words minimum
- Inner Reflection – An Advaita Lens:    150 words minimum
- A Sloka for the Path:                  120 words minimum (sloka text + full explanation)
- Practical Travel Notes:                150 words minimum (personal experience, not generic tips)
- Closing Reflection:                    120 words minimum

Each section must be full narrative prose — NOT a summary, NOT a bulleted list.
Practical Travel Notes must include personal sensory observations from this trip, not generic travel advice.
The Sloka section must include 3–4 sentences connecting the verse specifically to THIS journey and these images.

Before returning JSON, count the total words in markdown_content.
If below 950, expand the shortest sections until the total reaches 950–1,100.

═══════════════════════════════════════════════════
FACTUAL INPUTS — treat these as ground truth
═══════════════════════════════════════════════════

LOCATION:
${locationInstruction}

DATE:
${dateInstruction}

EXIF DATA (hardware-verified, highest trust):
- Latitude:  ${primaryExif?.latitude  ?? "not available"}
- Longitude: ${primaryExif?.longitude ?? "not available"}
- Altitude:  ${primaryExif?.altitude  ?? "not available"} meters
- Camera:    ${primaryExif?.cameraModel ?? "not available"}

VISUAL ANALYSIS (AI-observed, second highest trust):
- Location type:          ${visualAnalysis.location_type}
- Dominant elements:      ${visualAnalysis.dominant_elements?.join(", ")}
- Water present:          ${visualAnalysis.water_presence} — ${visualAnalysis.water_description || ""}
- Notable mountains:      ${visualAnalysis.notable_mountains}
- Sky conditions:         ${visualAnalysis.sky_conditions}
- Human activity:         ${visualAnalysis.human_activity}
- Architecture clues:     ${visualAnalysis.architecture_clues}
- Prayer flags:           ${visualAnalysis.prayer_flags}
- Vegetation:             ${visualAnalysis.vegetation}
- Altitude clue:          ${visualAnalysis.estimated_altitude_clue}
- Region inference:       ${visualAnalysis.region_inference}
- Landmark identified:    ${visualAnalysis.landmark_identification || "not identified"}
- Mood:                   ${visualAnalysis.mood}
- Specific visual details: ${visualAnalysis.specific_visual_details?.join(" | ")}

${metadataText}

Existing posts on this site (for potential internal links):
${existingPosts?.join(", ") || "None yet"}

═══════════════════════════════════════════════════
STRICT FABRICATION RULES
═══════════════════════════════════════════════════

1. NEVER invent a location name that is not provided or visually confirmed.
2. NEVER invent a year or date not supported by EXIF or tripContext.
3. NEVER name a specific mountain, lake, or monument unless it appears in the visual analysis or location data.
4. If water is visible in the images, DESCRIBE IT — do not write generic plateau content.
5. If location is unknown, use honest environmental description only.
6. If any EXIF value says "not available", do not fabricate a substitute.

═══════════════════════════════════════════════════
WRITING INSTRUCTIONS
═══════════════════════════════════════════════════

You are a reflective travel storyteller writing a personal spiritual diary.

TONE:
- Balanced: poetic + practical
- Grounded, sensory, honest
- Intimate — as if writing for yourself first, readers second
- No spiritual clichés, no exaggerated mysticism, not preachy
- Avoid: "life-changing", "soul awakening", "transformative", "eternal bliss", "sacred journey"

LENGTH: 950–1,100 words total. See per-section minimums at the top of this prompt.

SENSORY REQUIREMENT:
Every section must contain at least one grounded sensory detail:
- Light quality (angle, color, intensity)
- Sound or silence (wind, chanting, footsteps, nothing)
- Physical sensation (cold air, thin oxygen, weight of pack, burning thighs)
- Smell or texture where relevant

STRUCTURE — use these exact headings in this order:
## Introduction – Why This Journey
## The Landscape & Physical Experience
## Inner Reflection – An Advaita Lens
## A Sloka for the Path
## Practical Travel Notes
## Closing Reflection

ADVAITA REFLECTION (in "Inner Reflection" section):
- One paragraph only — subtle, not a lecture
- Touch on: witness consciousness, ego dissolution, or non-duality
- Ground it in something physically observed in the images

SLOKA (in "A Sloka for the Path" section):
- ONE canonical Sanskrit verse from: Bhagavad Gita, Upanishads, or Ashtavakra Gita only
- Provide: Sanskrit (Devanagari script), Transliteration, English meaning, Reference (chapter/verse), 2–3 sentence connection to this journey
- Only use well-known, accurately sourced verses — do not fabricate Sanskrit
- When uncertain, prefer Bhagavad Gita

INTERNAL LINK:
- If an existing post is relevant, add ONE natural reference — do not force it

═══════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════

SELF-CHECK BEFORE RETURNING:
1. Count words in markdown_content. If under 950 — do not return yet, keep writing.
2. Confirm all 6 section headings are present with "## " prefix.
3. Confirm title contains no form of "unknown", "unnamed", "untitled".
4. Confirm Devanagari Sanskrit is present in the sloka section.

Return ONLY valid JSON. No text before or after. No markdown fences.

{
  "title": "SEO-optimized title. If location is known, use it. If not, write an evocative title based on the dominant visual elements (e.g. terrain, sky, mood, activity). NEVER use the words unknown, unnamed, untitled, or mystery in the title.",
  "meta_description": "Max 155 characters — include location if known",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "markdown_content": "Full Markdown body with all 6 sections, WITHOUT frontmatter"
}
`.trim(),
          },
          ...images.map((img) => ({
            type: "input_image",
            image_url: `data:image/jpeg;base64,${img.base64}`,
          })),
        ],
      },
    ],
  });

  return response.output_text;
}

module.exports = { analyzeImages, generateTravelBlog };