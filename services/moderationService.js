// services/moderationService.js
const OpenAI = require("openai");
const sharp = require("sharp"); // npm install sharp
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
const MIN_FILE_SIZE_BYTES = 50 * 1024; // 50 KB

/**
 * Checks image resolution using sharp.
 * Returns { pass: bool, reason: string }
 */
async function checkResolution(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    const { width, height, size } = meta;

    if (!width || !height) {
      return { pass: false, reason: "Could not read image dimensions." };
    }
    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      return {
        pass: false,
        reason: `Image too small (${width}x${height}). Minimum required: ${MIN_WIDTH}x${MIN_HEIGHT}.`,
      };
    }
    if (buffer.length < MIN_FILE_SIZE_BYTES) {
      return {
        pass: false,
        reason: `Image file too small (${Math.round(buffer.length / 1024)}KB). Minimum: ${MIN_FILE_SIZE_BYTES / 1024}KB.`,
      };
    }

    return { pass: true, reason: null, width, height };
  } catch (err) {
    return { pass: false, reason: `Resolution check failed: ${err.message}` };
  }
}

/**
 * Runs OpenAI content moderation on a base64 image.
 * Uses the omni-moderation model which supports images.
 * Returns { pass: bool, reason: string, flaggedCategories: [] }
 */
async function checkContentModeration(base64Image) {
  try {
    const response = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${base64Image}`,
          },
        },
      ],
    });

    const result = response.results[0];

    if (result.flagged) {
      const flagged = Object.entries(result.categories)
        .filter(([, val]) => val === true)
        .map(([key]) => key);

      return {
        pass: false,
        reason: `Image flagged for: ${flagged.join(", ")}.`,
        flaggedCategories: flagged,
      };
    }

    return { pass: true, reason: null, flaggedCategories: [] };
  } catch (err) {
    // If moderation API fails, log but don't block the pipeline
    console.warn("Moderation API error (non-blocking):", err.message);
    return { pass: true, reason: null, flaggedCategories: [], warning: err.message };
  }
}

/**
 * Full moderation check for a single image buffer.
 * Step 1: resolution check
 * Step 2: OpenAI content moderation
 * Returns { pass: bool, reason: string, imageName: string }
 */
async function moderateImage(buffer, imageName) {
  // Step 1: Resolution
  const resCheck = await checkResolution(buffer);
  if (!resCheck.pass) {
    return { pass: false, reason: resCheck.reason, imageName, stage: "resolution" };
  }

  // Step 2: Content moderation
  const base64 = buffer.toString("base64");
  const modCheck = await checkContentModeration(base64);
  if (!modCheck.pass) {
    return { pass: false, reason: modCheck.reason, imageName, stage: "content", flaggedCategories: modCheck.flaggedCategories };
  }

  return { pass: true, reason: null, imageName, stage: null };
}

/**
 * Moderates all images in a batch.
 * Returns:
 *   approved: [{ buffer, name, base64 }]
 *   rejected: [{ imageName, reason, stage }]
 */
async function moderateImages(imageBuffers) {
  const approved = [];
  const rejected = [];

  for (const { buffer, name } of imageBuffers) {
    const result = await moderateImage(buffer, name);
    if (result.pass) {
      approved.push({ buffer, name, base64: buffer.toString("base64") });
    } else {
      console.warn(`❌ Image rejected [${result.stage}]: ${name} — ${result.reason}`);
      rejected.push({ imageName: name, reason: result.reason, stage: result.stage });
    }
  }

  return { approved, rejected };
}

module.exports = { moderateImages, moderateImage };
