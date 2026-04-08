// pipelines/blogPipeline.js
//
// Entry point called by mediaWatcher.js after a debounced batch of images
// arrives from ~/.openclaw/media/inbound/.
//
// Full flow:
//   mediaWatcher.js
//     → runPipelineForWhatsApp({ imageBuffers, tripName, userHandle, from })
//     → EXIF extraction
//     → metadata.json check (optional, user can drop alongside images)
//     → tripParser context enrichment
//     → reverse geocode (if GPS in EXIF)
//     → visual analysis (GPT-4o)
//     → blog generation (GPT-4o)
//     → quality gate
//     → write Markdown to Astro site
//     → optional git push
//     → WhatsApp reply with URL

const path = require("path");
const fs = require("fs");

const { extractExif } = require("../services/exifService");
const { reverseGeocode, normaliseUserLocation } = require("../services/locationService");
const { buildTripContext } = require("../services/tripParser");
const { analyzeImages, generateTravelBlog } = require("../services/aiService");
const { sendWhatsAppMessage, messages } = require("../services/whatsappService");

// ─── Config ───────────────────────────────────────────────────────────────────

const SITE_BLOG_ROOT =
  process.env.ASTRO_BLOG_ROOT ||
  "/home/anandixit/vedicjourneys/src/content/blog";

const SITE_BASE_URL =
  process.env.SITE_BASE_URL || "https://vedicjourneys.vercel.app";

// Set ENABLE_GIT_PUSH=true in .env to auto-commit + push after writing post
const ENABLE_GIT_PUSH = process.env.ENABLE_GIT_PUSH === "true";

const ASTRO_GIT_ROOT =
  process.env.ASTRO_GIT_ROOT ||
  "/home/anandixit/vedicjourneys";

// Where Astro serves static files from — images go here
const ASTRO_PUBLIC_ROOT =
  process.env.ASTRO_PUBLIC_ROOT ||
  "/home/anandixit/vedicjourneys/public";

const INBOUND_DIR =
  process.env.OPENCLAW_MEDIA_DIR ||
  path.join(process.env.HOME, ".openclaw/media/inbound");

// ─── Quality Gate ─────────────────────────────────────────────────────────────

function assessQuality(blogData, tripContext, resolvedLocation, visualAnalysis = {}) {
  const issues = [];
  const title = blogData.title || "";
  const content = blogData.markdown_content || "";
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  if (/unknown|unnamed|untitled/i.test(title))
    issues.push("Title contains 'unknown/unnamed/untitled'");

  if (/^Trip-\d{4}-\d{2}-\d{2}/i.test(title))
    issues.push("Title looks like an auto-generated date stamp");

  // Location check: pass if we have GPS, context location, region inference, OR identified landmark
  const hasAnyLocation =
    resolvedLocation ||
    tripContext.location ||
    (visualAnalysis.region_inference && visualAnalysis.region_inference !== "unclear") ||
    (visualAnalysis.landmark_identification && visualAnalysis.landmark_identification !== "not identified");

  if (!hasAnyLocation)
    issues.push("No location resolved — post may contain fabricated place names");

  if (wordCount < 750)
    issues.push(`Word count too low: ${wordCount} words (minimum 750 — target is 950+)`);
  else if (wordCount < 900)
    console.warn(`⚠️  Word count ${wordCount} is below target of 950 — post will pass but consider regenerating.`);

  const requiredSections = [
    "## Introduction",
    "## The Landscape",
    "## Inner Reflection",
    "## A Sloka",
    "## Practical Travel Notes",
    "## Closing Reflection",
  ];
  for (const s of requiredSections) {
    if (!content.includes(s)) issues.push(`Missing section: ${s}`);
  }

  // Devanagari Unicode check — sloka must have actual Sanskrit script
  if (!/[\u0900-\u097F]/.test(content))
    issues.push("No Devanagari Sanskrit found — sloka may be missing or malformed");

  const passed = issues.length === 0;
  const score = Math.max(0, 100 - issues.length * 15);
  return { passed, score, issues };
}

// ─── Optional git commit + push ───────────────────────────────────────────────

function gitPush(slug, userHandle) {
  if (!ENABLE_GIT_PUSH) {
    console.log("ℹ️  Git push skipped — set ENABLE_GIT_PUSH=true in .env to enable.");
    return;
  }
  try {
    const { execSync } = require("child_process");
    const msg = `feat: publish ${userHandle}/${slug}`;

    // Use SSH explicitly — required when running as background watcher process
    // Make sure SSH key is added: ssh-add ~/.ssh/id_rsa (or id_ed25519)
    const gitEnv = {
      ...process.env,
      GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=no -o BatchMode=yes",
    };
    const opts = { stdio: "pipe", env: gitEnv };

    const addOut = execSync(`git -C "${ASTRO_GIT_ROOT}" add -A`, opts).toString().trim();
    console.log("git add:", addOut || "(no output)");

    // Check if there's anything to commit
    const status = execSync(`git -C "${ASTRO_GIT_ROOT}" status --porcelain`, opts).toString().trim();
    if (!status) {
      console.log("ℹ️  Nothing to commit — file may already be tracked.");
      return;
    }

    const commitOut = execSync(`git -C "${ASTRO_GIT_ROOT}" commit -m "${msg}"`, opts).toString().trim();
    console.log("git commit:", commitOut);

    const pushOut = execSync(`git -C "${ASTRO_GIT_ROOT}" push`, opts).toString().trim();
    console.log("git push:", pushOut || "(no output)");

    console.log("🚀 Git push complete — Vercel deploy triggered.");
  } catch (err) {
    console.error("❌ Git push failed:", err.message);
    if (err.stderr) console.error("   stderr:", err.stderr.toString());
    console.error("   → Check: is SSH key added? Run: ssh-add ~/.ssh/id_ed25519");
    console.error("   → Check: git remote -v in", ASTRO_GIT_ROOT);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Called by mediaWatcher.js once a debounced image batch is ready.
 *
 * @param {object}   opts
 * @param {Array<{name: string, buffer: Buffer}>} opts.imageBuffers
 * @param {string}   opts.tripName       - e.g. "Trip-2026-02-27" from watcher
 * @param {string}   opts.userHandle     - e.g. "anand"
 * @param {string}   opts.from           - WhatsApp phone number
 * @param {string}   [opts.whatsappReply] - Optional follow-up metadata text from user
 */
async function runPipelineForWhatsApp({
  imageBuffers,
  tripName,
  userHandle,
  from,
  whatsappReply = null,
  suppressWhatsApp = false,
  visibility = "unlisted",
}) {
  console.log("─────────────────────────────────────────");
  console.log(`📸 Pipeline start | trip: ${tripName} | user: @${userHandle}`);

  // ── Step 1: EXIF extraction ──────────────────────────────────────────────
  const exifDataCollection = [];
  const imagePayloads = [];

  for (const img of imageBuffers) {
    const exifData = extractExif(img.buffer);
    if (exifData) {
      exifDataCollection.push({ image: img.name, ...exifData });
    }
    imagePayloads.push({
      name: img.name,
      base64: img.buffer.toString("base64"),
    });
  }

  const primaryExif =
    exifDataCollection.find((e) => e.dateTaken) ||
    exifDataCollection.find((e) => e.latitude && e.longitude) ||
    null;

  if (primaryExif) {
    console.log(`📷 EXIF: date=${primaryExif.dateTaken?.toISOString().slice(0, 10)} lat=${primaryExif.latitude} lon=${primaryExif.longitude} alt=${primaryExif.altitude}m`);
  } else {
    console.log("⚠️  No EXIF — WhatsApp stripped it. Using context fallbacks.");
  }

  // ── Step 2: Check for metadata.json in inbound dir ───────────────────────
  // User can drop a metadata.json into ~/.openclaw/media/inbound/ before/with images.
  // It is consumed once and deleted so it doesn't bleed into the next batch.
  //
  // Example metadata.json:
  // {
  //   "location": "Manasarovar Lake, Tibet",
  //   "year": "2024",
  //   "personal_reflection": "First time seeing the lake at dawn.",
  //   "physical_challenge": "Altitude sickness at 4,590m",
  //   "intention": "Pilgrimage"
  // }
  const metadataPath = path.join(INBOUND_DIR, "metadata.json");
  let metadata = null;
  if (fs.existsSync(metadataPath)) {
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      console.log("📋 metadata.json consumed:", metadata);
      fs.unlinkSync(metadataPath); // consume once
    } catch (e) {
      console.warn("⚠️  Could not parse metadata.json:", e.message);
    }
  }

  // ── Step 3: Build trip context ───────────────────────────────────────────
  // Priority: metadata.json > whatsappReply text > tripName folder parsing
  const tripContext = buildTripContext(tripName, metadata, whatsappReply);
  console.log(`📍 Context: location="${tripContext.location || "none"}" year="${tripContext.year || "none"}" confidence=${tripContext.confidence} [${tripContext.sources.join(", ")}]`);

  if (tripContext.isLowContext) {
    console.warn("⚠️  Low context — narrative will rely on visual analysis only.");
  }

  // ── Step 4: Reverse geocode from EXIF GPS ───────────────────────────────
  let resolvedLocation = null;
  if (primaryExif?.latitude && primaryExif?.longitude) {
    resolvedLocation = await reverseGeocode(primaryExif.latitude, primaryExif.longitude);
    console.log("🌍 GPS-resolved location:", resolvedLocation);
  }

  // Fall back to context-derived location
  if (!resolvedLocation && tripContext.location) {
    resolvedLocation = tripContext.location;
    console.log("🗂️  Context location:", resolvedLocation);
  }

  // ── Step 5: Resolve publication date ────────────────────────────────────
  const pubDate = primaryExif?.dateTaken
  ? primaryExif.dateTaken.toISOString().slice(0, 10)
  : metadata?.date
  ? metadata.date.slice(0, 10)   // uses 2025-11-02 from your web form
  : new Date().toISOString().slice(0, 10);
  
  console.log("📅 pubDate:", pubDate);

  // ── Step 6: Visual analysis ──────────────────────────────────────────────
  console.log("🔍 Running visual analysis...");
  const visualAnalysis = await analyzeImages(imagePayloads);

  // ── Step 7: Blog generation ──────────────────────────────────────────────
  console.log("✍️  Generating blog post...");

  // Scan Astro folder for existing posts so AI can suggest internal links
  const existingPosts = getExistingPostSlugs(userHandle);

  const blogRaw = await generateTravelBlog(
    imagePayloads,
    tripName,
    metadata,
    existingPosts,
    visualAnalysis,
    primaryExif,
    resolvedLocation,
    tripContext,
  );

  let blogData;
  try {
    const cleaned = blogRaw.replace(/```json/g, "").replace(/```/g, "").trim();
    blogData = JSON.parse(cleaned);
  } catch (err) {
    console.error("❌ AI returned invalid JSON:", blogRaw.slice(0, 300));
    // Retry once with a simpler prompt if AI refused
    console.log("🔄 Retrying blog generation...");
    try {
      const retryRaw = await generateTravelBlog(
        imagePayloads, tripName, null, existingPosts,
        visualAnalysis, primaryExif, resolvedLocation, whatsappReply
      );
      const retryCleaned = retryRaw.replace(/```json/g, "").replace(/```/g, "").trim();
      blogData = JSON.parse(retryCleaned);
      console.log("✅ Retry succeeded.");
    } catch (retryErr) {
      if (!suppressWhatsApp) await sendWhatsAppMessage(from, messages.error(tripName));
      throw retryErr;
    }
  }

  // Auto-retry if word count too low
  const wordCount = blogData.markdown_content?.split(/\s+/).filter(Boolean).length || 0;
  if (wordCount < 750) {
    console.log(`🔄 Word count ${wordCount} too low — retrying for longer post...`);
    try {
      const retryRaw = await generateTravelBlog(
        imagePayloads, tripName, null, existingPosts,
        visualAnalysis, primaryExif, resolvedLocation, whatsappReply
      );
      const retryCleaned = retryRaw.replace(/```json/g, "").replace(/```/g, "").trim();
      const retryData = JSON.parse(retryCleaned);
      const retryWords = retryData.markdown_content?.split(/\s+/).filter(Boolean).length || 0;
      if (retryWords > wordCount) {
        console.log(`✅ Retry word count: ${retryWords}`);
        blogData = retryData;
      }
    } catch (retryErr) {
      console.warn("⚠️  Retry failed — using original:", retryErr.message);
    }
  }

  // ── Step 8: Quality gate ─────────────────────────────────────────────────
  const quality = assessQuality(blogData, tripContext, resolvedLocation, visualAnalysis);
  console.log(`\n🔍 Quality: ${quality.passed ? "✅ PASSED" : "⚠️  FLAGGED"} (score: ${quality.score}/100)`);
  if (quality.issues.length) quality.issues.forEach((i) => console.warn("   ·", i));

  // ── Step 9: Build slug + final Markdown ─────────────────────────────────
  const safe = (s) => String(s ?? "").replace(/"/g, '\\"').trim();

  const slug = blogData.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const readTime = Math.ceil(blogData.markdown_content.split(" ").length / 200);

  // Copy hero image (first image in batch) to Astro public folder
  let heroImageUrl = "";
  if (imageBuffers.length > 0) {
    try {
      const heroImgDir = path.join(ASTRO_PUBLIC_ROOT, "blog-images", userHandle);
      fs.mkdirSync(heroImgDir, { recursive: true });
      const heroImgFilename = `${slug}.jpg`;
      const heroImgPath = path.join(heroImgDir, heroImgFilename);
      fs.writeFileSync(heroImgPath, imageBuffers[0].buffer);
      heroImageUrl = `/blog-images/${userHandle}/${heroImgFilename}`;
      console.log(`🖼️  Hero image saved: ${heroImgPath}`);
    } catch (err) {
      console.warn("⚠️  Could not save hero image:", err.message);
    }
  }

  const rawLocation = resolvedLocation
    || (tripContext.location !== "null" ? tripContext.location : null)
    || (!/^Trip-\d/.test(tripName) ? tripName : "");
  const normalisedLocation = normaliseUserLocation(rawLocation) || rawLocation || "";

  const finalMarkdown = `---
title: "${safe(blogData.title)}"
description: "${safe(blogData.meta_description || blogData.description)}"
pubDate: ${pubDate}
heroImage: "${heroImageUrl}"
user: "${userHandle}"
visibility: "${visibility}"
location: "${safe(normalisedLocation)}"
keywords: ${JSON.stringify(blogData.keywords || [])}
readTime: ${readTime}
qualityScore: ${quality.score}
contextConfidence: "${tripContext.confidence}"
---

${blogData.markdown_content}
`;

  // ── Step 10: Write to Astro ──────────────────────────────────────────────
  // Quality-passed posts → src/content/blog/<userHandle>/
  // Flagged posts        → src/content/blog/_review/<userHandle>/
  const targetDir = quality.passed
    ? path.join(SITE_BLOG_ROOT, userHandle)
    : path.join(SITE_BLOG_ROOT, "_review", userHandle);

  fs.mkdirSync(targetDir, { recursive: true });
  const astroPath = path.join(targetDir, `${slug}.md`);
  fs.writeFileSync(astroPath, finalMarkdown);

  if (quality.passed) {
    console.log(`\n✅ Post written: ${astroPath}`);
  } else {
    console.warn(`\n⚠️  Flagged — written to _review: ${astroPath}`);
  }

  // ── Step 11: Optional git push ───────────────────────────────────────────
  if (quality.passed) gitPush(slug, userHandle);

  // ── Step 12: WhatsApp reply ──────────────────────────────────────────────
  const postUrl = `${SITE_BASE_URL}/u/${userHandle}/${slug}`;

 if (!suppressWhatsApp) {
  if (quality.passed) {
    await sendWhatsAppMessage(from, messages.success(blogData.title, postUrl));
  } else {
    const issueLines = quality.issues.map((i) => `• ${i}`).join("\n");
    await sendWhatsAppMessage(
      from,
      `⚠️ Post generated but needs review (score: ${quality.score}/100).\n\n${issueLines}\n\nDraft saved — check _review folder.`
    );
  }
 }

  console.log("─────────────────────────────────────────\n");
  const finalWordCount = blogData.markdown_content?.split(/\s+/).filter(Boolean).length || 0;
  return { slug, title: blogData.title, url: postUrl, quality, resolvedLocation, wordCount: finalWordCount };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Scans the Astro blog folder for existing post slugs.
 * Used to suggest internal links in AI generation.
 */
function getExistingPostSlugs(userHandle) {
  try {
    const dir = path.join(SITE_BLOG_ROOT, userHandle);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""));
  } catch {
    return [];
  }
}

module.exports = { runPipelineForWhatsApp };