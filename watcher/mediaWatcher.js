// watcher/mediaWatcher.js
// Watches ~/.openclaw/media/inbound/ for new JPEGs dropped by OpenClaw.
// Batches images that arrive within DEBOUNCE_MS, then runs a single-question
// intake conversation before triggering the blog pipeline.
//
// Intake flow:
//   [image arrives]
//   Bot → "📍 Where was this? ✨ What made it special?"
//   User replies → OpenClaw agent writes it to ~/.openclaw/workspace/memory/YYYY-MM-DD.md
//   We poll that file for new content → pipeline fires with context
//
// If user doesn't reply within INTAKE_TIMEOUT_MS, pipeline fires with images only.
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

// OpenClaw agent writes daily memory here — we poll this for context replies
const MEMORY_DIR =
  process.env.OPENCLAW_MEMORY_DIR ||
  path.join(process.env.HOME, ".openclaw/workspace/memory");

// How long to wait after the LAST image arrives before treating it as a complete batch
const DEBOUNCE_MS = parseInt(process.env.WATCHER_DEBOUNCE_MS || "3000");

// How long to wait for intake reply before proceeding with images only
const INTAKE_TIMEOUT_MS = parseInt(process.env.INTAKE_TIMEOUT_MS || "120000"); // 2 minutes

const DEFAULT_FROM = process.env.MY_WHATSAPP_NUMBER || "+18585253554";

const PHONE_TO_HANDLE = {
  [DEFAULT_FROM]: "anand",
  "+18585253582": "vidya",
};

// ─── State ────────────────────────────────────────────────────────────────────

const pendingBatches = new Map();
const processedFiles = new Set();

function seedProcessedFiles() {
  if (!fs.existsSync(WATCH_DIR)) {
    console.warn(`⚠️  Watch dir not found: ${WATCH_DIR}`);
    return;
  }
  const existing = fs.readdirSync(WATCH_DIR).filter(isImageFile);
  existing.forEach((f) => processedFiles.add(path.join(WATCH_DIR, f)));
  console.log(`📂 Seeded ${existing.length} existing files as already-processed.`);
}

function isImageFile(filePath) {
  return /\.(jpg|jpeg|png|webp)$/i.test(filePath);
}

// ─── Memory file polling ──────────────────────────────────────────────────────
// The OpenClaw agent writes the user's text reply into today's memory file.
// We snapshot the file length BEFORE asking the question, then poll for
// new content appearing AFTER we sent our question.

function getTodayMemoryPath() {
  const today = new Date().toISOString().split("T")[0];
  return path.join(MEMORY_DIR, `${today}.md`);
}

function getMemoryBaseLength() {
  const p = getTodayMemoryPath();
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, "utf8").length;
}

function extractContextFromMemoryDelta(delta) {
  // The agent writes lines like:
  // "- The user mentioned visiting Gowri Kund, Mt Kailash..."
  // "- Received context reply: location=Gowri Kund, moment=first glimpse of the lake"
  // We want the raw content — strip leading "- " bullet and return the rest
  const lines = delta
    .split("\n")
    .map(l => l.replace(/^[-*]\s*/, "").trim())
    .filter(l => l.length > 5);

  return lines.join(" | ") || delta.trim();
}

function waitForMemoryReply(baseLength, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();

    const interval = setInterval(() => {
      try {
        const p = getTodayMemoryPath();
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, "utf8");
          if (content.length > baseLength) {
            const delta = content.slice(baseLength).trim();
            // Make sure it's meaningful new content, not just whitespace
            if (delta.length > 5) {
              clearInterval(interval);
              const extracted = extractContextFromMemoryDelta(delta);
              console.log(`   📝 Memory delta: "${extracted}"`);
              resolve(extracted);
            }
          }
        }
      } catch {
        // File being written — wait for next poll
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 1000);
  });
}

// ─── Intake conversation ──────────────────────────────────────────────────────

async function runIntake(from, filePaths) {
  const userHandle = PHONE_TO_HANDLE[from];
  if (!userHandle) {
    console.warn(`Unknown sender ${from} — skipping.`);
    return;
  }

  console.log(`\n💬 Starting intake for ${from} → @${userHandle}`);

  // Snapshot memory file length BEFORE sending the question
  const baseLength = getMemoryBaseLength();

  // Single question — ask for location + moment together
  await sendWhatsAppMessage(
    from,
    `📸 Got your photo${filePaths.length > 1 ? "s" : ""}!\n\n` +
    `Reply with:\n` +
    `📍 *Where* — location (e.g. "Gowri Kund, Mt Kailash")\n` +
    `✨ *What* — one line, what made it special\n\n` +
    `_e.g. "Gowri Kund, Mt Kailash — first glimpse of the sacred lake after 3 days of trekking"_`
  );

  console.log(`   Waiting for reply (${INTAKE_TIMEOUT_MS / 1000}s)...`);
  const reply = await waitForMemoryReply(baseLength, INTAKE_TIMEOUT_MS);

  if (!reply) {
    console.log(`   ⏱ No reply — proceeding with images only.`);
    await firePipeline(from, userHandle, filePaths, null);
    return;
  }

  console.log(`   ✅ Context: "${reply}"`);
  await firePipeline(from, userHandle, filePaths, reply);
}

// ─── Pipeline execution ───────────────────────────────────────────────────────

async function firePipeline(from, userHandle, filePaths, contextReply) {
  const imageBuffers = filePaths
    .filter((fp) => fs.existsSync(fp))
    .map((fp) => ({
      name: path.basename(fp),
      buffer: fs.readFileSync(fp),
    }));

  if (imageBuffers.length === 0) {
    console.warn("No readable files in batch — skipping.");
    return;
  }

  const tripName = `Trip-${new Date().toISOString().split("T")[0]}`;

  console.log(`\n🚀 Firing pipeline | @${userHandle} | ${imageBuffers.length} image(s)`);
  if (contextReply) console.log(`   Context: "${contextReply}"`);
  else console.log(`   No context — visual analysis only.`);

  // Brief pause between intake and AI calls to avoid rate limits
  await new Promise(r => setTimeout(r, 3000));

  await sendWhatsAppMessage(from, messages.processing(tripName));

  try {
    await runPipelineForWhatsApp({
      imageBuffers,
      tripName,
      userHandle,
      from,
      whatsappReply: contextReply || null,
    });
  } catch (err) {
    console.error("Pipeline error:", err);
    await sendWhatsAppMessage(from, messages.error(tripName));
  }
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

function startWatcher() {
  seedProcessedFiles();
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  console.log(`👀 Watching: ${WATCH_DIR}`);
  console.log(`   Memory dir: ${MEMORY_DIR}`);
  console.log(`   Debounce: ${DEBOUNCE_MS}ms | Intake timeout: ${INTAKE_TIMEOUT_MS / 1000}s\n`);

  const watcher = chokidar.watch(WATCH_DIR, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on("add", (filePath) => {
    if (!isImageFile(filePath)) return;
    if (processedFiles.has(filePath)) return;

    processedFiles.add(filePath);
    console.log(`📥 New image: ${path.basename(filePath)}`);

    const from = DEFAULT_FROM;

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
      console.log(`⏱  Debounce complete — ${filesToProcess.length} image(s). Starting intake.`);
      await runIntake(from, filesToProcess);
    }, DEBOUNCE_MS);
  });

  watcher.on("error", (err) => console.error("Watcher error:", err));
  watcher.on("ready", () => {
    console.log("✅ Watcher ready — send images from WhatsApp to start the intake flow.\n");
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

startWatcher();