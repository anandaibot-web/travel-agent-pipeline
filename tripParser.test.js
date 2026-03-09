/**
 * tripParser.js
 *
 * Extracts structured context (location, date, notes) from:
 *   1. Folder names  e.g. "Manasarovar-Oct2024" or "Kailash-Parikrama-2025"
 *   2. WhatsApp metadata replies (plain text message from user)
 *   3. metadata.json already present in the Drive folder
 *
 * Priority order when merging:
 *   metadata.json  >  WhatsApp reply  >  folder name  >  null
 */

// ─── Month name / abbreviation map ───────────────────────────────────────────
const MONTH_MAP = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

// ─── Known location aliases (extend as you travel more) ──────────────────────
const LOCATION_ALIASES = {
  manasarovar: "Manasarovar Lake, Tibet",
  kailash: "Mount Kailash, Tibet",
  lhasa: "Lhasa, Tibet",
  kathmandu: "Kathmandu, Nepal",
  kedarnath: "Kedarnath, Uttarakhand",
  badrinath: "Badrinath, Uttarakhand",
  gangotri: "Gangotri, Uttarakhand",
  yamunotri: "Yamunotri, Uttarakhand",
  varanasi: "Varanasi, Uttar Pradesh",
  rishikesh: "Rishikesh, Uttarakhand",
  haridwar: "Haridwar, Uttarakhand",
  everest: "Everest Base Camp, Nepal",
  ebc: "Everest Base Camp, Nepal",
  tibet: "Tibet",
  nepal: "Nepal",
  india: "India",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tries to parse a year (4-digit) from a string token.
 */
function extractYear(token) {
  const m = token.match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

/**
 * Tries to parse a month token into a zero-padded month string "01"–"12".
 */
function extractMonth(token) {
  const lower = token.toLowerCase().replace(/[^a-z]/g, "");
  return MONTH_MAP[lower] || null;
}

/**
 * Tries to resolve a token to a known location alias.
 * Returns the canonical name or null.
 */
function resolveAlias(token) {
  const lower = token.toLowerCase().replace(/[^a-z]/g, "");
  return LOCATION_ALIASES[lower] || null;
}

/**
 * Parse a folder name like:
 *   "Manasarovar-Oct2024"
 *   "Kailash-Parikrama-2025"
 *   "Kathmandu-Boudhanath-Nov-2024"
 *   "Trip-2026-02-27"          ← auto-generated fallback (returns low-confidence flag)
 *
 * Returns: { location, year, month, isGeneric, rawName }
 */
function parseFolderName(folderName) {
  const result = {
    location: null,
    year: null,
    month: null,
    isGeneric: false,
    rawName: folderName,
  };

  // Detect auto-generated generic names
  if (/^Trip-\d{4}-\d{2}-\d{2}$/.test(folderName)) {
    result.isGeneric = true;
    result.year = folderName.slice(5, 9);
    return result;
  }

  // Split on hyphens, underscores, spaces
  const tokens = folderName.split(/[-_\s]+/);

  const locationTokens = [];

  for (const token of tokens) {
    const year = extractYear(token);
    if (year) { result.year = year; continue; }

    // Token might be "Oct2024" — split numeric suffix
    const monthYearMatch = token.match(/^([A-Za-z]+)(\d{4})$/);
    if (monthYearMatch) {
      const month = extractMonth(monthYearMatch[1]);
      if (month) {
        result.month = month;
        result.year = monthYearMatch[2];
        continue;
      }
    }

    const month = extractMonth(token);
    if (month) { result.month = month; continue; }

    // Otherwise treat as a location token
    locationTokens.push(token);
  }

  if (locationTokens.length) {
    // Try to resolve each token against known aliases first
    for (const tok of locationTokens) {
      const alias = resolveAlias(tok);
      if (alias) {
        result.location = alias;
        break;
      }
    }

    // If no alias matched, join the remaining tokens as a human-readable place name
    if (!result.location) {
      result.location = locationTokens
        .map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
        .join(" ");
    }
  }

  return result;
}

/**
 * Parse a WhatsApp plain-text metadata reply from the user.
 *
 * Expected format (flexible — lines in any order):
 *   📍 Location: Manasarovar Lake, Tibet
 *   📅 Date: October 2024
 *   ✍️ One line: First time seeing the lake at dawn
 *
 * Also accepts bare format:
 *   location: Kailash
 *   date: 2025
 *   note: parikrama day 3
 *
 * Returns: { location, year, month, note }
 */
function parseWhatsAppReply(text) {
  if (!text || typeof text !== "string") return {};

  const result = {};
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Strip emoji prefixes
    const clean = line.replace(/^[\p{Emoji}\s]+/u, "").trim();

    const colonIdx = clean.indexOf(":");
    if (colonIdx === -1) continue;

    const key = clean.slice(0, colonIdx).trim().toLowerCase();
    const value = clean.slice(colonIdx + 1).trim();

    if (!value) continue;

    if (key.includes("location") || key.includes("place") || key.includes("loc")) {
      // Try alias resolution first
      const alias = resolveAlias(value.split(/[\s,]/)[0]);
      result.location = alias || value;
    }

    if (key.includes("date") || key.includes("when") || key.includes("year")) {
      // Try to extract year
      const year = extractYear(value);
      if (year) result.year = year;

      // Try to extract month
      const tokens = value.split(/[\s,-]+/);
      for (const t of tokens) {
        const month = extractMonth(t);
        if (month) { result.month = month; break; }
      }
    }

    if (key.includes("note") || key.includes("one line") || key.includes("caption") || key.includes("reflection")) {
      result.note = value;
    }
  }

  return result;
}

/**
 * Merge all context sources into a single enriched context object.
 *
 * @param {string} folderName   - Google Drive folder name
 * @param {object|null} metadata - Parsed metadata.json (if present)
 * @param {string|null} whatsappReply - Raw WhatsApp reply text (if available)
 *
 * Returns:
 * {
 *   location: string|null,       // Best resolved location string
 *   year: string|null,           // 4-digit year
 *   month: string|null,          // "01"–"12"
 *   pubDateStr: string|null,     // "YYYY-MM" or "YYYY" best effort
 *   note: string|null,           // Personal one-liner
 *   isLowContext: boolean,        // true if we have very little to work with
 *   confidence: "high"|"medium"|"low",
 *   sources: string[],           // Which sources contributed
 * }
 */
function buildTripContext(folderName, metadata = null, whatsappReply = null) {
  const sources = [];

  // Start with folder name parse
  const folderCtx = parseFolderName(folderName);

  // Parse WhatsApp reply
  const waCtx = parseWhatsAppReply(whatsappReply);

  // Priority merge: metadata.json > whatsapp > folder
  let location = null;
  const sanitizeLoc = (v) => (v && v !== "null" && v.trim() !== "" ? v.trim() : null);
  let year = null;
  let month = null;
  let note = null;

  // Location
  if (metadata?.location) {
    location = sanitizeLoc(metadata.location);
    sources.push("metadata.json");
  } else if (waCtx.location) {
    location = sanitizeLoc(waCtx.location);
    sources.push("whatsapp-reply");
  } else if (folderCtx.location) {
    location = sanitizeLoc(folderCtx.location);
    sources.push("folder-name");
  }

  // Year
  if (metadata?.year) {
    year = String(metadata.year);
    if (!sources.includes("metadata.json")) sources.push("metadata.json");
  } else if (waCtx.year) {
    year = waCtx.year;
    if (!sources.includes("whatsapp-reply")) sources.push("whatsapp-reply");
  } else if (folderCtx.year) {
    year = folderCtx.year;
    if (!sources.includes("folder-name")) sources.push("folder-name");
  }

  // Month
  month = waCtx.month || folderCtx.month || null;

  // Personal note
  note = metadata?.personal_reflection || waCtx.note || null;

  // Build a best-effort pubDate string (for frontmatter fallback)
  let pubDateStr = null;
  if (year && month) pubDateStr = `${year}-${month}-01`;
  else if (year) pubDateStr = `${year}-01-01`;

  // Confidence scoring
  // hasLocation: true if we have a final resolved location from ANY source
  const hasLocation = !!location;
  const hasDate = !!year;
  const hasNote = !!note;

  let confidence = "low";
  if (hasLocation && hasDate && hasNote) confidence = "high";
  else if (hasLocation && hasDate) confidence = "medium";
  else if (hasLocation || hasDate) confidence = "low";

  // isLowContext = true when there is no resolved location to anchor the narrative
  const isLowContext = !hasLocation;

  return {
    location,
    year,
    month,
    pubDateStr,
    note,
    isLowContext,
    confidence,
    sources,
    _folderCtx: folderCtx, // expose for debugging
  };
}

module.exports = {
  parseFolderName,
  parseWhatsAppReply,
  buildTripContext,
};