// watcher/pipelineWebhook.js
//
// HTTP server that bridges the Vercel contributor portal and the local pipeline.
//
// Vercel can't run your Node pipeline directly (it's serverless + no filesystem).
// This server runs on your local machine alongside mediaWatcher.js and receives
// POST requests from Vercel's /api/contribute/submit endpoint.
//
// Flow:
//   Contributor form on Vercel
//     → POST /pipeline to this server (via ngrok tunnel or Tailscale)
//     → runPipelineForWhatsApp({ imageBuffers, ... })
//     → returns { url, quality, wordCount, slug }
//
// Port: 18791 (configurable via PIPELINE_WEBHOOK_PORT)
//
// For Vercel to reach this server, expose it via:
//   Option A: ngrok → ngrok http 18791 → set PIPELINE_WEBHOOK_URL in Vercel env
//   Option B: Tailscale → set PIPELINE_WEBHOOK_URL to your Tailscale IP
//   Option C: Same machine as Vercel (if self-hosting) → localhost

const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { runPipelineForWhatsApp } = require('../pipelines/blogPipeline');

const PORT = parseInt(process.env.PIPELINE_WEBHOOK_PORT || '18791');
const SECRET = process.env.PIPELINE_SECRET || 'vj-pipeline-secret';
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://vedicjourneys.vercel.app';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {

  // ── CORS for Vercel ──────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pipeline-secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const secret = req.headers['x-pipeline-secret'];
  if (secret !== SECRET) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  // ── Health check ──────────────────────────────────────────────────────────
  if (req.url === '/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, port: PORT });
  }

  // ── Pipeline trigger ──────────────────────────────────────────────────────
  if (req.url === '/pipeline' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { error: 'Invalid JSON' });
    }

    const { imageBuffers, tripName, userHandle, from, whatsappReply, visibility } = body;

    if (!imageBuffers?.length || !userHandle) {
      return json(res, 400, { error: 'imageBuffers and userHandle required' });
    }

    // Convert base64 back to buffers
    const buffers = imageBuffers.map(img => ({
      name: img.name,
      buffer: Buffer.from(img.base64, 'base64'),
    }));

    console.log(`\n🌐 Web submission | @${userHandle} | ${buffers.length} image(s)`);
    console.log(`   Trip: ${tripName}`);
    if (whatsappReply) console.log(`   Context: ${whatsappReply.slice(0, 80)}…`);

    try {
      const result = await runPipelineForWhatsApp({
        imageBuffers: buffers,
        tripName,
        userHandle,
        from: from || `web:${userHandle}`,
        whatsappReply: whatsappReply || null,
        visibility: visibility || 'unlisted',
        // Web submissions don't send WhatsApp notifications
        suppressWhatsApp: !from?.startsWith('+'),
      });

      if (!result?.url) throw new Error('Pipeline returned no URL');

      console.log(`✅ Web submission complete: ${result.url}`);
      return json(res, 200, {
        url: result.url,
        slug: result.slug,        
		quality: result.quality?.score ?? result.quality,
        wordCount: result.wordCount,
      });

    } catch (err) {
      console.error('❌ Pipeline error:', err.message);
      return json(res, 500, { error: err.message });
    }
  }
  
  // ADD THIS BLOCK to pipelineWebhook.js
// Insert it just BEFORE the final:  json(res, 404, { error: 'Not found' });

  // ── Review: Approve (move _review → published) ───────────────────────────
  if (req.url === '/review/approve' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { slug, userHandle } = body;
    if (!slug || !userHandle) return json(res, 400, { error: 'slug and userHandle required' });

    const BLOG_ROOT = process.env.ASTRO_BLOG_ROOT ||
      path.join(__dirname, '../../vedicjourneys-site/vedicjourneys/src/content/blog');

    const reviewPath = path.join(BLOG_ROOT, '_review', userHandle, `${slug}.md`);
    const publishPath = path.join(BLOG_ROOT, userHandle, `${slug}.md`);

    if (!fs.existsSync(reviewPath)) {
      return json(res, 404, { error: 'Post not found in review folder' });
    }

    try {
      fs.mkdirSync(path.dirname(publishPath), { recursive: true });
      fs.copyFileSync(reviewPath, publishPath);
      fs.unlinkSync(reviewPath);

      // Git push
      const { execSync } = require('child_process');
      const repoRoot = path.join(__dirname, '../../vedicjourneys-site/vedicjourneys');
      execSync(`cd ${repoRoot} && git add . && git commit -m "feat: approve ${userHandle}/${slug}" && git push`, { stdio: 'pipe' });
      console.log(`✅ Approved and published: ${userHandle}/${slug}`);

      const url = `${SITE_BASE_URL}/u/${userHandle}/${slug}`;
      return json(res, 200, { ok: true, url });
    } catch (err) {
      console.error('Approve error:', err.message);
      return json(res, 500, { error: err.message });
    }
  }

  // ── Review: Reject (delete from _review) ────────────────────────────────
  if (req.url === '/review/reject' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { slug, userHandle } = body;
    if (!slug || !userHandle) return json(res, 400, { error: 'slug and userHandle required' });

    const BLOG_ROOT = process.env.ASTRO_BLOG_ROOT ||
      path.join(__dirname, '../../vedicjourneys-site/vedicjourneys/src/content/blog');

    const reviewPath = path.join(BLOG_ROOT, '_review', userHandle, `${slug}.md`);

    if (!fs.existsSync(reviewPath)) {
      return json(res, 404, { error: 'Post not found' });
    }

    try {
      fs.unlinkSync(reviewPath);

      // Also remove hero image if present
      const heroPath = path.join(__dirname, '../../vedicjourneys-site/vedicjourneys/public/blog-images', userHandle, `${slug}.jpg`);
      if (fs.existsSync(heroPath)) fs.unlinkSync(heroPath);

      const { execSync } = require('child_process');
      const repoRoot = path.join(__dirname, '../../vedicjourneys-site/vedicjourneys');
      execSync(`cd ${repoRoot} && git add . && git commit -m "chore: reject ${userHandle}/${slug}" && git push`, { stdio: 'pipe' });
      console.log(`🗑️  Rejected and deleted: ${userHandle}/${slug}`);

      return json(res, 200, { ok: true });
    } catch (err) {
      console.error('Reject error:', err.message);
      return json(res, 500, { error: err.message });
    }
  }

  // ── Review: Toggle visibility ────────────────────────────────────────────
  if (req.url === '/review/visibility' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { slug, userHandle, visibility } = body;
    if (!slug || !userHandle || !['public', 'unlisted'].includes(visibility)) {
      return json(res, 400, { error: 'slug, userHandle, and visibility (public|unlisted) required' });
    }

    const BLOG_ROOT = process.env.ASTRO_BLOG_ROOT ||
      path.join(__dirname, '../../vedicjourneys-site/vedicjourneys/src/content/blog');

    const publishPath = path.join(BLOG_ROOT, userHandle, `${slug}.md`);

    if (!fs.existsSync(publishPath)) {
      return json(res, 404, { error: 'Post not found' });
    }

    try {
      const raw = fs.readFileSync(publishPath, 'utf8');
      const updated = raw.replace(/^visibility:.*$/m, `visibility: "${visibility}"`);
      fs.writeFileSync(publishPath, updated);

      const { execSync } = require('child_process');
      const repoRoot = path.join(__dirname, '../../vedicjourneys-site/vedicjourneys');
      execSync(`cd ${repoRoot} && git add . && git commit -m "feat: set-${visibility} ${userHandle}/${slug}" && git push`, { stdio: 'pipe' });
      console.log(`🔁 Visibility updated: ${userHandle}/${slug} → ${visibility}`);

      return json(res, 200, { ok: true, visibility });
    } catch (err) {
      console.error('Visibility error:', err.message);
      return json(res, 500, { error: err.message });
    }
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Pipeline webhook listening on http://0.0.0.0:${PORT}`);
  console.log(`   POST /pipeline  — submit images for blog generation`);
  console.log(`   GET  /health    — health check`);
  console.log(`   Secret: ${SECRET}`);
  console.log('');
  console.log('   To expose to Vercel:');
  console.log(`   → ngrok http ${PORT}  (then set PIPELINE_WEBHOOK_URL in Vercel env vars)`);
  console.log(`   → or Tailscale: http://<your-tailscale-ip>:${PORT}`);
  console.log('');
});

server.on('error', err => console.error('Pipeline webhook error:', err.message));

module.exports = server;
