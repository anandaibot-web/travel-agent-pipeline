// watcher/mediaWatcher.js
//
// Multi-user image watcher for Vedic Journeys.
//
// Since OpenClaw drops all images into a single flat inbound/ folder with no
// sender metadata in the filename, we use a SESSION FILE approach:
//
//   ~/.openclaw/media/sessions/<phone>.json
//
// Each yatri's OpenClaw agent skill writes a session file when they send images,
// containing { from, files: [...] }. The watcher reads this to identify the sender.
//
// Context collection flow:
//   1. Images arrive → debounce → watcher detects batch
//   2. Watcher sends context prompt to yatri via WhatsApp
//   3. Yatri replies with location/date/note (written to context file by skill)
//   4. Watcher detects context file → fires pipeline immediately
//   5. Pipeline uses context → writes post + metadata JSON to Astro site
//   6. Git push → URL sent back to yatri
//
// FALLBACK: if no session file exists, defaults to DEFAULT_FROM (anand) — safe for testing.
//
// TESTING without OpenClaw skill:
//   node -e "require('./watcher/mediaWatcher').injectContext('+18585253582', '📍 Location: Manasarovar, Tibet\n📅 Date: October 2024')"
//
// Run with: node watcher/mediaWatcher.js

const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { runPipelineForWhatsApp } = require("../pipelines/blogPipeline");
const { sendWhatsAppMessage, messages } = require("../services/whatsappService");

// ─── Config ───────────────────────────────────────────────────────────────────

const WATCH_DIR =
  process.env.OPENCLAW_MEDIA_DIR ||
  path.join(process.env.HOME, ".openclaw/media/inbound");

// Session files live here — written by OpenClaw skill or injectContext()
const SESSION_DIR =
  process.env.SESSION_DIR ||
  path.join(process.env.HOME, ".openclaw/media/sessions");

const DEBOUNCE_MS     = parseInt(process.env.WATCHER_DEBOUNCE_MS || "3000");
const CONTEXT_WAIT_MS = parseInt(process.env.CONTEXT_WAIT_MS     || "120000"); // 2 min
const CONTEXT_TTL_MS  = parseInt(process.env.CONTEXT_TTL_MS      || "600000"); // 10 min

// ── Yatri registry ────────────────────────────────────────────────────────────
// Add new yatris here. Key = WhatsApp number (with +), value = URL handle.
const PHONE_TO_HANDLE = {
  [process.env.MY_WHATSAPP_NUMBER || "+18585253554"]: "anand",
  "+18585253582": "vidya",
  // "+91XXXXXXXXXX": "newhandle",
};

const DEFAULT_FROM = process.env.MY_WHATSAPP_NUMBER || "+18585253554";

// ─── In-memory state ──────────────────────────────────────────────────────────

const pendingBatches  = new Map(); // phone → { timer, files[] }
const awaitingContext = new Map(); // phone → { files[], waitTimer }
const pendingContext  = new Map(); // phone → { text, receivedAt }  (in-memory fallback)
const processedFiles  = new Set();

// ─── Session / context file helpers ──────────────────────────────────────────

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Reads and consumes a session file matching any of the given filenames.
// Session file format: { "from": "+18585253554", "files": ["uuid.jpg"] }
function readSessionForFiles(fileNames) {
  ensureSessionDir();
  try {
    const sessions = fs.readdirSync(SESSION_DIR)
      .filter(f => f.endsWith(".json") && !f.includes("-context"));

    for (const sf of sessions) {
      const sp = path.join(SESSION_DIR, sf);
      try {
        const session = JSON.parse(fs.readFileSync(sp, "utf8"));
        if (session.files?.some(f => fileNames.includes(f))) {
          fs.unlinkSync(sp);
          const from = normalizePhone(session.from);
          console.log(`📋 Session matched sender: ${from}`);
          return from;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Context file format: { "from": "+18585253554", "text": "...", "receivedAt": 123 }
// Written by OpenClaw skill when yatri replies to context prompt.
function readContextFile(from) {
  ensureSessionDir();
  const cp = path.join(SESSION_DIR, `${from.replace("+", "")}-context.json`);
  if (!fs.existsSync(cp)) return null;
  try {
    const ctx = JSON.parse(fs.readFileSync(cp, "utf8"));
    fs.unlinkSync(cp);
    console.log(`📝 Context file consumed for ${from}`);
    return ctx.text || null;
  } catch {
    return null;
  }
}

// Public — used by OpenClaw skill or injectContext() for testing
function writeContextFile(from, text) {
  ensureSessionDir();
  const cp = path.join(SESSION_DIR, `${from.replace("+", "")}-context.json`);
  fs.writeFileSync(cp, JSON.stringify({ from, text, receivedAt: Date.now() }, null, 2));
  console.log(`✍️  Context file written for ${from}`);
}

// Consume context: file takes priority over in-memory
function consumeContext(from) {
  const fileCtx = readContextFile(from);
  if (fileCtx) return fileCtx;

  const mem = pendingContext.get(from);
  if (!mem) return null;
  if (Date.now() - mem.receivedAt > CONTEXT_TTL_MS) {
    pendingContext.delete(from);
    console.log(`⏰ In-memory context expired for ${from}`);
    return null;
  }
  pendingContext.delete(from);
  return mem.text;
}

// ─── Context prompt ───────────────────────────────────────────────────────────

const CONTEXT_PROMPT = (handle) =>
`📸 *Got your photos, ${handle}!*

To write a richer, more authentic blog post, please reply with:

📍 *Location:* Where were you? _(e.g. Manasarovar Lake, Tibet)_
📅 *Date:* When was this? _(e.g. October 2024)_
✍️ *One line:* What made this moment special?
🏔️ *Challenge:* Any physical or emotional difficulty? _(optional)_
🙏 *Intention:* Why this journey? _(optional)_

_You have 2 minutes to reply — or I'll generate from the images alone._`;

// ─── Save trip metadata to Astro site ────────────────────────────────────────
// Persists context to src/content/blog/<handle>/_metadata/<slug>.json
// so it's versioned alongside the post in git.

function saveMetadataToAstro(userHandle, slug, context, resolvedLocation) {
  const ASTRO_BLOG_ROOT =
    process.env.ASTRO_BLOG_ROOT ||
    "/home/anandixit/vedicjourneys-site/vedicjourneys/src/content/blog";

  const metaDir = path.join(ASTRO_BLOG_ROOT, userHandle, "_metadata");
  fs.mkdirSync(metaDir, { recursive: true });

  const metaPath = path.join(metaDir, `${slug}.json`);
  const metadata = {
    slug,
    userHandle,
    resolvedLocation: resolvedLocation || null,
    rawContext: context || null,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  console.log(`💾 Metadata saved: ${metaPath}`);
}

// ─── Process a completed batch ────────────────────────────────────────────────

async function processBatch(from, filePaths, whatsappReply = null) {
  const userHandle = PHONE_TO_HANDLE[from];
  if (!userHandle) {
    console.warn(`⚠️  ${from} not in PHONE_TO_HANDLE — skipping.`);
    await sendWhatsAppMessage(from,
      `⚠️ Your number isn't registered on Vedic Journeys yet. Please contact the admin.`
    );
    return;
  }

  console.log(`\n🚀 Pipeline | ${filePaths.length} image(s) | ${from} → @${userHandle}`);

  const imageBuffers = filePaths
    .filter(fp => fs.existsSync(fp))
    .map(fp => ({ name: path.basename(fp), buffer: fs.readFileSync(fp) }));

  if (!imageBuffers.length) {
    console.warn("No readable files — skipping.");
    return;
  }

  const tripName = `Trip-${new Date().toISOString().split("T")[0]}`;
  await sendWhatsAppMessage(from, messages.processing(tripName));

  try {
    const result = await runPipelineForWhatsApp({
      imageBuffers,
      tripName,
      userHandle,
      from,
      whatsappReply,
    });

    // Persist metadata alongside post in Astro site
    if (result?.slug) {
      saveMetadataToAstro(userHandle, result.slug, whatsappReply, result.resolvedLocation);
    }
  } catch (err) {
    console.error("❌ Pipeline error:", err.message);
    await sendWhatsAppMessage(from, messages.error(tripName));
  }
}

// ─── Handle debounced batch ───────────────────────────────────────────────────

async function handleBatch(from, filePaths) {
  const userHandle = PHONE_TO_HANDLE[from] || "yatri";

  // Check if context was pre-sent (before images)
  const existingContext = consumeContext(from);
  if (existingContext) {
    console.log(`✅ Pre-sent context found — firing immediately.`);
    await processBatch(from, filePaths, existingContext);
    return;
  }

  // No context — send prompt, wait for reply
  console.log(`💬 Sending context prompt to ${from}, waiting ${CONTEXT_WAIT_MS / 1000}s…`);
  await sendWhatsAppMessage(from, CONTEXT_PROMPT(userHandle));

  const waitTimer = setTimeout(async () => {
    if (!awaitingContext.has(from)) return;
    console.log(`⏰ Context timeout for ${from} — generating from images alone.`);
    awaitingContext.delete(from);
    const lateContext = consumeContext(from);
    await processBatch(from, filePaths, lateContext || null);
  }, CONTEXT_WAIT_MS);

  awaitingContext.set(from, { files: filePaths, waitTimer });
}

// ─── Called when context reply arrives ───────────────────────────────────────

async function onContextReceived(from, text) {
  pendingContext.set(from, { text, receivedAt: Date.now() });

  if (awaitingContext.has(from)) {
    const { files, waitTimer } = awaitingContext.get(from);
    clearTimeout(waitTimer);
    awaitingContext.delete(from);

    console.log(`🎯 Context received — firing waiting batch for ${from}`);
    await sendWhatsAppMessage(from, `✅ Perfect — generating your post now…`);
    await processBatch(from, files, text);
  } else {
    await sendWhatsAppMessage(from,
      `✅ Context saved! Send your photos whenever you're ready.`
    );
  }
}

// ─── File watcher ─────────────────────────────────────────────────────────────

function seedProcessedFiles() {
  if (!fs.existsSync(WATCH_DIR)) {
    console.warn(`⚠️  Watch dir not found: ${WATCH_DIR}`);
    return;
  }
  const existing = fs.readdirSync(WATCH_DIR).filter(isImageFile);
  existing.forEach(f => processedFiles.add(path.join(WATCH_DIR, f)));
  console.log(`📂 Seeded ${existing.length} existing files as already-processed.`);
}

function isImageFile(fp) { return /\.(jpg|jpeg|png|webp)$/i.test(fp); }

function startWatcher() {
  seedProcessedFiles();
  ensureSessionDir();

  const handles = Object.entries(PHONE_TO_HANDLE)
    .map(([k, v]) => `${v} (${k})`).join(", ");
  console.log(`👀 Watching: ${WATCH_DIR}`);
  console.log(`📁 Sessions: ${SESSION_DIR}`);
  console.log(`👥 Yatris: ${handles}\n`);

  // ── Image watcher
  const imageWatcher = chokidar.watch(WATCH_DIR, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  imageWatcher.on("add", (filePath) => {
    if (!isImageFile(filePath)) return;
    if (processedFiles.has(filePath)) return;
    processedFiles.add(filePath);

    console.log(`📥 New image: ${path.basename(filePath)}`);

    const fileNames = [path.basename(filePath)];
    const detectedFrom = readSessionForFiles(fileNames) || DEFAULT_FROM;
    const from = PHONE_TO_HANDLE[detectedFrom] ? detectedFrom : DEFAULT_FROM;

    if (pendingBatches.has(from)) {
      clearTimeout(pendingBatches.get(from).timer);
      pendingBatches.get(from).files.push(filePath);
    } else {
      pendingBatches.set(from, { files: [filePath], timer: null });
    }

    const batch = pendingBatches.get(from);
    batch.timer = setTimeout(async () => {
      const filesToProcess = [...batch.files];
      pendingBatches.delete(from);
      console.log(`⏱  Debounce complete — ${filesToProcess.length} image(s) for ${from}`);
      await handleBatch(from, filesToProcess);
    }, DEBOUNCE_MS);
  });

  // ── Session dir watcher (context reply files)
  const sessionWatcher = chokidar.watch(SESSION_DIR, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  sessionWatcher.on("add", async (filePath) => {
    const fname = path.basename(filePath);
    if (!fname.endsWith("-context.json")) return;

    await new Promise(r => setTimeout(r, 200)); // ensure fully written
    try {
      const ctx = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (ctx.from && ctx.text) {
        console.log(`📬 Context file arrived for ${ctx.from}`);
        await onContextReceived(normalizePhone(ctx.from), ctx.text);
      }
    } catch (err) {
      console.error("Failed to parse context file:", err.message);
    }
  });

  imageWatcher.on("error",   err => console.error("Image watcher error:", err));
  sessionWatcher.on("error", err => console.error("Session watcher error:", err));
  imageWatcher.on("ready",   ()  => console.log("✅ Watcher ready.\n"));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return raw;
  return `+${raw.replace(/\D/g, "")}`;
}

// ─── Public API (for testing + OpenClaw skill integration) ────────────────────

async function injectContext(from, text) {
  const normalized = normalizePhone(from);
  writeContextFile(normalized, text);
  await onContextReceived(normalized, text);
}

// ─── Start ────────────────────────────────────────────────────────────────────

startWatcher();

module.exports = { injectContext, onContextReceived, writeContextFile };