// services/locationService.js
const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "..", ".cache", "geocode.json");

function loadCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function keyFor(lat, lon) {
  // round to reduce cache fragmentation
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}


// Cleans up user-typed or pipeline-generated location strings
// Examples:
//   "Manasarovar2025"           → "Manasarovar, Tibet"
//   "Mt Kailash"                → "Mount Kailash, Tibet"
//   "Mount Kailash, Tibet"      → "Mount Kailash, Tibet" (unchanged)
//   "Kathmandu Metropolitan City, Bagamati Province" → "Kathmandu, Nepal"
//   "Trip-2025-07-03"           → null
//   ""                          → null

const LOCATION_OVERRIDES = new Map([
  // Kailash variants
  ['mt kailash',          'Mount Kailash, Tibet'],
  ['mt. kailash',         'Mount Kailash, Tibet'],
  ['mount kailash',       'Mount Kailash, Tibet'],
  ['kailash',             'Mount Kailash, Tibet'],
  ['kailash mansarovar',  'Mount Kailash, Tibet'],
  // Manasarovar variants
  ['manasarovar',         'Manasarovar, Tibet'],
  ['manasarovar2025',     'Manasarovar, Tibet'],
  ['mansarovar',          'Manasarovar, Tibet'],
  ['lake manasarovar',    'Manasarovar, Tibet'],
  // Lhasa
  ['chengguan district',  'Lhasa, Tibet'],
  ['lhasa',               'Lhasa, Tibet'],
  // Kathmandu
  ['kathmandu metropolitan city', 'Kathmandu, Nepal'],
  ['kathmandu metropolitan city, bagamati province', 'Kathmandu, Nepal'],
  // Kedarnath
  ['kedarnath',           'Kedarnath, Uttarakhand'],
  // Badrinath
  ['badrinath',           'Badrinath, Uttarakhand'],
  // Darchen
  ['darchen',             'Darchen, Tibet'],
]);

function normaliseUserLocation(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Drop Trip- prefixed names
  if (/^Trip-/i.test(raw.trim())) return null;

  // Strip trailing years like "2025", "2024"
  const cleaned = raw.trim().replace(/\s*\d{4}\s*$/, '').trim();

  if (!cleaned) return null;

  // Check override map (case-insensitive)
  const key = cleaned.toLowerCase();
  if (LOCATION_OVERRIDES.has(key)) return LOCATION_OVERRIDES.get(key);

  // Check partial match (e.g. "Manasarovar2025" → strip digits → "Manasarovar")
  const stripped = cleaned.replace(/\d+/g, '').trim().toLowerCase();
  if (stripped && LOCATION_OVERRIDES.has(stripped)) return LOCATION_OVERRIDES.get(stripped);

  // If already has a comma (e.g. "Darchen, Tibet"), trust it
  if (cleaned.includes(',')) return cleaned;

  // Otherwise return as-is (capitalised)
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}



function normalizeLocation(label) {
  if (!label) return null;

  // If it contains Tibet Autonomous Region, simplify to "Tibet"
  label = label.replace(/Tibet Autonomous Region/gi, "Tibet");

  // Optional: drop "China" for travel tone (your choice)
  label = label.replace(/,\s*China$/i, "");

  // Keep it compact: "City, Region" or "City, Country"
  const parts = label.split(",").map(s => s.trim()).filter(Boolean);


  const replaceMap = new Map([
	  ["Chengguan District", "Lhasa"],
	  // You can add more as you discover them:
	  // ["Dzongyab County", "Lhasa"],
	]);

  if (parts[0] && replaceMap.has(parts[0])) {
	parts[0] = replaceMap.get(parts[0]);
  }


  // Prefer first 2 parts
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
  return parts[0] || label;
  
  
}

async function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return null;

  const cache = loadCache();
  const key = keyFor(lat, lon);
  if (cache[key]) return cache[key];

  // Nominatim requires a User-Agent identifying your app
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("accept-language", "en");
  url.searchParams.set("format", "json");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("zoom", "10");
  url.searchParams.set("addressdetails", "1");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "vedicjourneys/1.0 (contact: anand.aibot@gmail.com)",
	  "Accept-Language": "en",
      "Accept": "application/json",
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const a = data.address || {};

  // pick best available locality label
  const city =
    a.city || a.town || a.village || a.municipality || a.county || a.state_district;

  const region = a.state || a.region;
  const country = a.country;

  const label = [city, region, country].filter(Boolean).join(", ");

  //const label = [city, region, country].filter(Boolean).join(", ") || data.display_name || null;

	const normalized = normalizeLocation(label || data.display_name || null);

	cache[key] = normalized;
	saveCache(cache);

	

  // Be polite to Nominatim
  await new Promise((r) => setTimeout(r, 1100));

  return normalized;
}

module.exports = { reverseGeocode, normaliseUserLocation };