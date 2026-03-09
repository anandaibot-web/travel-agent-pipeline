const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

// Set AI_PROVIDER=claude or AI_PROVIDER=openai in your .env
const PROVIDER = (process.env.AI_PROVIDER || "openai").toLowerCase();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const OPENAI_MODEL = "gpt-4o-mini";
const CLAUDE_MODEL = "claude-sonnet-4-6";

console.log(`[aiService] Using provider: ${PROVIDER.toUpperCase()} (${PROVIDER === "claude" ? CLAUDE_MODEL : OPENAI_MODEL})`);

// ---------------------------------------------------------------------------
// analyzeImages
// ---------------------------------------------------------------------------

async function analyzeImages(images) {
  const promptText = `
Analyze the attached travel images objectively.

Return ONLY valid JSON in this structure:

{
  "location_type": "",
  "dominant_elements": ["lake", "snow peaks", "pilgrims", ...],
  "notable_mountains": "",
  "water_presence": true/false,
  "sky_conditions": "",
  "human_activity": "",
  "mood": "",
  "specific_visual_details": [
    "detail 1",
    "detail 2"
  ]
}

Do not write narrative. Only factual visual analysis.
`;

  let rawText;

  if (PROVIDER === "claude") {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            ...images.map(img => ({
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: img.base64 }
            }))
          ]
        }
      ]
    });
    rawText = response.content.find(b => b.type === "text")?.text || "";

  } else {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: promptText },
            ...images.map(img => ({
              type: "input_image",
              image_url: `data:image/jpeg;base64,${img.base64}`
            }))
          ]
        }
      ]
    });
    rawText = response.output_text;
  }

  const cleaned = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// generateTravelBlog
// ---------------------------------------------------------------------------

async function generateTravelBlog(images, tripName, metadata, existingPosts, visualAnalysis, primaryExif, resolvedLocation) {

  if (!primaryExif) {
    console.log("No EXIF data found. Using folder naming fallback.");
  }

  const metadataText = metadata
    ? `
Location: ${metadata.location || ""}
Year: ${metadata.year || ""}
Personal Reflection: ${metadata.personal_reflection || ""}
Physical Challenge: ${metadata.physical_challenge || ""}
Intention: ${metadata.intention || ""}
`
    : "No additional personal metadata provided.";

  const promptText = `
You are a reflective travel writer and spiritual diarist. Your task is to write a deeply immersive,
first-person blog post about a pilgrimage journey. You write from INSIDE the experience —
not from outside the photograph.

═══════════════════════════════════════
CRITICAL WRITING RULES — READ FIRST
═══════════════════════════════════════

NEVER do any of the following:
- Describe what people in photos are wearing (jacket colours, masks, hats)
- Count or reference how many people are in a photo ("forty-plus people", "a group of pilgrims")
- Read or narrate visible text in images (banners, signs, boards)
- Describe a photo as an object ("the photograph shows...", "in the image...")
- Write like a journalist reporting on others — write as the person who was THERE
- Use the word "photograph" or "image" in the narrative body

ALWAYS do the following:
- Write in first-person singular ("I", "we" when natural for a group journey)
- Ground sensory writing in what the BODY experiences: breath, cold, effort, sound, smell, light
- Use the place and environment as backdrop, not the people in it
- Let the inner journey emerge from the physical one

═══════════════════════════════════════
FACTUAL INPUTS — USE THESE PRECISELY
═══════════════════════════════════════

Location: ${resolvedLocation || tripName || "Unknown"}
Altitude (m): ${primaryExif?.altitude ?? "Unknown"}
Date: ${primaryExif?.dateTaken ?? "Unknown"}
Coordinates: ${primaryExif?.latitude ?? "?"}, ${primaryExif?.longitude ?? "?"}

Visual scene analysis:
- Location type: ${visualAnalysis.location_type}
- Key elements present: ${(visualAnalysis.dominant_elements || []).join(", ")}
- Water present: ${visualAnalysis.water_presence}
- Notable mountains: ${visualAnalysis.notable_mountains || "none identified"}
- Sky: ${visualAnalysis.sky_conditions}
- Human activity: ${visualAnalysis.human_activity}
- Mood/atmosphere: ${visualAnalysis.mood}
- Specific details: ${(visualAnalysis.specific_visual_details || []).join(", ")}

Personal trip context:
${metadataText}

Existing posts on this site (for optional internal reference):
${existingPosts?.join(", ") || "None yet"}
If genuinely relevant, you may reference ONE existing post naturally in the text.
Do NOT fabricate links.

═══════════════════════════════════════
SECTION GUIDANCE
═══════════════════════════════════════

## Introduction – Why This Journey
Write about the PULL of this place — what draws a person here, what it means to arrive.
Write from the inside. No photo narration. No banner reading. Personal motivation and context.

## The Landscape & Physical Experience
Describe the terrain, altitude, weather, and what the BODY feels here.
Focus on: thin air, cold, terrain underfoot, sound, wind, light quality, the sky.
Draw from visual analysis for scene details but translate them into felt, sensory experience.
Do NOT describe clothing on people. Do NOT describe people at all beyond "fellow pilgrims"
or "we" when the writer is part of the scene.
If a stupa, mani stones, or prayer flags are present — describe their presence as encountered
in person, not as objects in a frame.

## Inner Reflection – An Advaita Lens
Explore what this place and physical experience provokes philosophically.
Use non-duality, witness consciousness, or ego dissolution — grounded, not abstract.
Let the reflection arise naturally from the physical details above. Not preachy. Not lecture-like.

## A Sloka for the Path
Include ONE authentic canonical Sanskrit sloka from Bhagavad Gita, Upanishads,
or Ashtavakra Gita only.
- Only well-known, accurately quoted canonical verses
- Prefer Bhagavad Gita if uncertain about exact Sanskrit accuracy
- Do NOT fabricate Sanskrit

Format exactly as:
**Sanskrit:** [verse]
**Transliteration:** [transliteration]
**Meaning:** [meaning]
**Reference:** [Chapter/Verse]
**Relevance:** [2-3 sentences connecting verse to this specific journey moment]

## Practical Travel Notes
Genuine, useful travel information for someone planning this journey.
Cover: permits, best season, altitude preparation, gear essentials, logistics.
Do NOT reference visible clothing from photos. Write from knowledge of the route.
Keep tone practical and direct — like advice from a fellow traveler, not a tour brochure.

## Closing Reflection
End with a quiet, honest observation. Not inspirational-poster language.
Something true and specific to this place and this moment. Under 150 words.

═══════════════════════════════════════
QUALITY STANDARDS
═══════════════════════════════════════

Length: 950–1100 words total across all sections.
Tone: Grounded. Sensory. Honest. Poetic only when earned by specificity.
Forbidden phrases: "life-changing", "soul awakening", "transformative experience",
"eternal bliss", "mystical journey", "spiritual awakening", "once in a lifetime".

═══════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════

Return ONLY valid JSON. No text outside JSON. No markdown fences around JSON.

{
  "title": "SEO optimized title (under 65 characters)",
  "meta_description": "Under 155 characters, specific to this place and journey",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "markdown_content": "Full structured markdown body WITHOUT frontmatter"
}
`;

  let rawText;

  if (PROVIDER === "claude") {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            ...images.map(img => ({
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: img.base64 }
            }))
          ]
        }
      ]
    });
    rawText = response.content.find(b => b.type === "text")?.text || "";

  } else {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: promptText },
            ...images.map(img => ({
              type: "input_image",
              image_url: `data:image/jpeg;base64,${img.base64}`
            }))
          ]
        }
      ]
    });
    rawText = response.output_text;
  }

  return rawText;
}

module.exports = {
  analyzeImages,
  generateTravelBlog
};