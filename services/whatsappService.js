// services/whatsappService.js
// Sends WhatsApp replies via OpenClaw gateway RPC.
// Correct method: "send" with idempotencyKey + message fields.

const { execSync } = require("child_process");
require("dotenv").config();

const OPENCLAW_BIN =
  process.env.OPENCLAW_BIN ||
  "/home/anandixit/.npm-global/bin/openclaw";

const GATEWAY_TOKEN =
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  "942d03243034ec806e6e22ff13b3d0656e82cdf97ea545a2";

const GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL ||
  "ws://127.0.0.1:18789";

/**
 * Sends a WhatsApp message via OpenClaw gateway RPC.
 * @param {string} to      - Phone number e.g. "+18585253554"
 * @param {string} message - Message body
 */
async function sendWhatsAppMessage(to, message) {
  try {
    const idempotencyKey = `vj-${Date.now()}`;

    const params = JSON.stringify({
      idempotencyKey,
      channel: "whatsapp",
      to,
      message,
    });

    const cmd = `${OPENCLAW_BIN} gateway call send \
      --url ${GATEWAY_URL} \
      --token ${GATEWAY_TOKEN} \
      --params '${params.replace(/'/g, "'\\''")}'`;

    const output = execSync(cmd, { timeout: 15000 }).toString();
    console.log(`✅ WhatsApp reply sent to ${to}`);
    return output;
  } catch (err) {
    console.error(`WhatsApp send error: ${err.message}`);
  }
}

/**
 * Pre-built message templates
 */
const messages = {
  processing: (tripName) =>
    `✈️ Got your photos for *${tripName}*! Generating your blog post now — usually takes 1–2 minutes.`,

  success: (title, url) =>
    `✅ Your blog post is live!\n\n*${title}*\n\n🔗 ${url}\n\n_Visibility is unlisted. Only people with the link can see it._`,

  rejectedImages: (rejected) => {
    const lines = rejected.map((r) => `  • ${r.imageName}: ${r.reason}`);
    return (
      `⚠️ Some images were rejected:\n\n` +
      lines.join("\n") +
      `\n\nPost was generated from your remaining approved images.`
    );
  },

  allImagesRejected: () =>
    `❌ All images failed quality or safety checks — post could not be generated.\n\n• Min size: 800x600px\n• Min file: 50KB\n• No inappropriate content`,

  noImages: () =>
    `⚠️ No images found. Send photos directly in WhatsApp (not as documents).`,

  error: (tripName) =>
    `❌ Something went wrong generating your post for *${tripName}*. Please try again.`,
};

module.exports = { sendWhatsAppMessage, messages };
