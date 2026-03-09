// watcher/senderWebhook.js
//
// Tiny Express server that receives sender metadata from OpenClaw skill.
// When OpenClaw receives an image, its skill POSTs:
//   { "from": "+18585253582", "files": ["uuid.jpg"] }
// This writes a session file that mediaWatcher.js reads to identify the sender.
//
// Also accepts context replies:
//   POST /context  { "from": "+18585253582", "text": "📍 Location: ..." }
//
// Run alongside mediaWatcher.js (started by your run script).
// Port: 18790 (configurable via WEBHOOK_PORT env)

const http = require("http");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const SESSION_DIR =
  process.env.SESSION_DIR ||
  path.join(process.env.HOME, ".openclaw/media/sessions");

const PORT = parseInt(process.env.WEBHOOK_PORT || "18790");

// Simple shared secret so only OpenClaw skill can post
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "vj-local-secret";

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function normalizePhone(raw) {
  if (!raw) return null;
  return `+${raw.replace(/\D/g, "")}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Auth check
  const secret = req.headers["x-webhook-secret"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (secret !== WEBHOOK_SECRET) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // CORS / preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  ensureSessionDir();

  // ── POST /session — register image sender ──────────────────────────────────
  // Called by OpenClaw skill immediately when image arrives
  // Body: { "from": "+18585253582", "files": ["uuid.jpg", ...] }
  if (req.url === "/session") {
    const from = normalizePhone(body.from);
    const files = body.files || [];

    if (!from || !files.length) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "from and files required" }));
      return;
    }

    const sessionPath = path.join(SESSION_DIR, `${from.replace("+", "")}.json`);
    const session = { from, files, createdAt: Date.now() };
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));

    console.log(`✅ Session registered: ${from} → [${files.join(", ")}]`);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST /context — store yatri's context reply ───────────────────────────
  // Called by OpenClaw skill when user sends text reply to the context prompt
  // Body: { "from": "+18585253582", "text": "📍 Location: Manasarovar..." }
  if (req.url === "/context") {
    const from = normalizePhone(body.from);
    const text = body.text?.trim();

    if (!from || !text) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "from and text required" }));
      return;
    }

    const contextPath = path.join(SESSION_DIR, `${from.replace("+", "")}-context.json`);
    const ctx = { from, text, receivedAt: Date.now() };
    fs.writeFileSync(contextPath, JSON.stringify(ctx, null, 2));

    console.log(`✅ Context stored: ${from} → "${text.slice(0, 60)}…"`);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /health ───────────────────────────────────────────────────────────
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, sessions: SESSION_DIR }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🔌 Sender webhook listening on http://127.0.0.1:${PORT}`);
  console.log(`   POST /session  — register image sender`);
  console.log(`   POST /context  — store context reply`);
  console.log(`   Secret: ${WEBHOOK_SECRET}\n`);
});

server.on("error", err => {
  console.error("Webhook server error:", err.message);
});

module.exports = server;
