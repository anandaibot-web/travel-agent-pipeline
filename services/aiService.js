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
      max_tokens: 2048,
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
  // ── BUILD METADATA BLOCK ─────────────────────────────────────────────────────
	// Collect every field the web form may send. Nothing is dropped silently.
	const hasSpecialEvent = metadata?.one_line || metadata?.personal_reflection || metadata?.intention;

	const metadataText = metadata ? `
	Location (writer-provided):    ${metadata.location || ""}
	Date of visit (writer-provided): ${metadata.date || metadata.year || ""}
	One-line highlight:            ${metadata.one_line || ""}
	Personal reflection:           ${metadata.personal_reflection || ""}
	Physical / emotional challenge: ${metadata.physical_challenge || ""}
	Journey intention:              ${metadata.intention || ""}
	`.trim() : null;


  const promptText = `
	You are a reflective travel writer and spiritual diarist. Your task is to write a deeply immersive,
	first-person blog post about a pilgrimage journey. You write from INSIDE the experience —
	not from outside the photograph.

	═══════════════════════════════════════════════════
	WRITER'S PERSONAL CONTEXT  ←  HIGHEST PRIORITY
	═══════════════════════════════════════════════════
	${metadataText ? `
	The writer submitted the following context for this post.
	This is the SPINE of the narrative. Every section must reflect it.

	${metadataText}

	SPECIAL INSTRUCTION:
	- The "one-line highlight" is the single most important moment of the trip.
	  It MUST appear prominently — ideally in the Introduction or Closing.
	- If the date of visit or personal reflection references a rare, historically
	  significant, or once-in-a-generation event (e.g. Maha Kumbh Mela, a total
	  solar eclipse, a centennial festival), you MUST:
		1. Name it explicitly in the Introduction.
		2. Explain its significance in 2–3 sentences.
		3. Let it shape the emotional register of the entire post.
	- "Journey intention" drives the Introduction's opening paragraph.
	- "Personal reflection" is the seed of the Inner Reflection section.
	- "Physical / emotional challenge" must appear in The Landscape section.
	` : `No personal context provided. Write from visual and location data only.`}

	═══════════════════════════════════════════════════
	CRITICAL WRITING RULES — READ BEFORE WRITING
	═══════════════════════════════════════════════════

	NEVER:
	- Describe clothing on people in images (jacket colours, masks, hats)
	- Count or reference how many people appear ("forty-plus pilgrims")
	- Read or narrate visible text in images (banners, signs, boards)
	- Describe a photo as an object ("the photograph shows...", "in the image...")
	- Write like a journalist observing others — write as the person who was THERE
	- Use the words "photograph" or "image" in the narrative body

	ALWAYS:
	- Write in first-person singular ("I", "we" when natural)
	- Ground sensory writing in what the BODY experiences: breath, cold, effort, sound, smell, light
	- Use place and environment as backdrop, not the people in it

	═══════════════════════════════════════════════════
	FACTUAL INPUTS  ←  USE TO GROUND PHYSICAL DETAILS
	═══════════════════════════════════════════════════

	Location: ${resolvedLocation || metadata?.location || tripName || "Unknown"}
	Altitude (m): ${primaryExif?.altitude ?? "Unknown"}
	Date: ${primaryExif?.dateTaken ?? metadata?.date ?? metadata?.year ?? "Unknown"}
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

	Existing posts on this site (for optional internal reference):
	${existingPosts?.join(", ") || "None yet"}
	If genuinely relevant, reference ONE existing post naturally. Do NOT fabricate links.

	═══════════════════════════════════════════════════
	SECTION GUIDANCE
	═══════════════════════════════════════════════════

	## Introduction – Why This Journey
	Open with WHY the writer came here — drawn directly from "Why this journey" and the
	one-line highlight. If a rare event (Kumbh Mela, eclipse, centennial festival) is present
	in the context, NAME IT in the first or second paragraph and explain its significance.
	This is not optional. Do not bury it.

	## The Landscape & Physical Experience
	Describe the terrain, altitude, weather, and what the BODY feels here.
	Focus on: thin air, cold, terrain underfoot, sound, wind, light quality, the sky.
	If a physical or emotional challenge was provided, weave it into this section.
	Do NOT describe clothing. Do NOT enumerate people.

	## Inner Reflection – through Vedanta Lens
	Ground this in the "personal reflection" field if provided. Let the philosophical
	observation arise from that seed, not generically from the location.
	Vedanta, non-duality, witness consciousness — grounded, not abstract, not preachy.

	## A Sloka for the Path
	ONE authentic canonical Sanskrit sloka from Bhagavad Gita, Upanishads, or Ashtavakra Gita.
	- Well-known, accurately quoted canonical verses only
	- Prefer Bhagavad Gita if uncertain
	- Do NOT fabricate Sanskrit

	Format exactly:
	**Sanskrit:** [verse]
	**Transliteration:** [transliteration]
	**Meaning:** [meaning]
	**Reference:** [Chapter/Verse]
	**Relevance:** [2–3 sentences connecting this verse to the writer's specific context]

	## Practical Travel Notes
	Genuine, useful travel information. Permits, best season, altitude prep, logistics.
	Tone: practical and direct, like advice from a fellow traveler.

	## Closing Reflection
	End with a quiet, honest, specific observation. Under 150 words.
	No inspirational-poster language. Something true to this place and this writer's moment.

	═══════════════════════════════════════════════════
	QUALITY STANDARDS
	═══════════════════════════════════════════════════

	Length: 700–900 words total across all sections.
	Tone: Grounded. Sensory. Honest. Poetic only when earned by specificity.
	Forbidden phrases: "life-changing", "soul awakening", "transformative experience",
	"eternal bliss", "mystical journey", "spiritual awakening", "once in a lifetime".

	═══════════════════════════════════════════════════
	OUTPUT FORMAT
	═══════════════════════════════════════════════════

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