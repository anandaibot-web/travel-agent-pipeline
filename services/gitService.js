// services/gitService.js
// Auto-commits and pushes new blog posts to the Astro site GitHub repo.
// Uses simple-git: npm install simple-git

const simpleGit = require("simple-git");
const path = require("path");
require("dotenv").config();

const ASTRO_REPO_PATH =
  process.env.ASTRO_REPO_PATH ||
  "/home/anandixit/vedicjourneys-site/vedicjourneys";

/**
 * Commits and pushes a newly generated blog post to GitHub.
 * Vercel will auto-deploy on push (configure in Vercel dashboard).
 *
 * @param {string} slug       - Post slug (used in commit message)
 * @param {string} userHandle - Author handle
 * @param {string} title      - Post title (used in commit message)
 * @returns {{ success: boolean, commitHash?: string, error?: string }}
 */
async function commitAndPush(slug, userHandle, title) {
  const git = simpleGit(ASTRO_REPO_PATH);

  try {
    // Verify repo is clean enough to work with
    const status = await git.status();

    // Stage only the new/modified blog post file
    const relativeFilePath = path.join(
      "src/content/blog",
      userHandle,
      `${slug}.md`
    );

    await git.add(relativeFilePath);

    // Check if there's actually something staged
    const statusAfterAdd = await git.status();
    if (
      statusAfterAdd.staged.length === 0 &&
      statusAfterAdd.created.length === 0
    ) {
      console.warn("Nothing staged — post may already be committed.");
      return { success: true, commitHash: null, skipped: true };
    }

    const commitMessage = `feat(blog): add post "${title}" [${userHandle}/${slug}]`;
    const commitResult = await git.commit(commitMessage);

    const commitHash = commitResult.commit;
    console.log(`✅ Git commit: ${commitHash} — "${commitMessage}"`);

    // Push to origin main (adjust branch name if needed)
    const branch = process.env.GIT_BRANCH || "main";
    await git.push("origin", branch);
    console.log(`✅ Pushed to origin/${branch}`);

    return { success: true, commitHash };
  } catch (err) {
    console.error("Git commit/push failed:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Returns the expected public URL for a post on Vercel.
 * Set VERCEL_SITE_URL in .env, e.g. https://vedicjourneys.vercel.app
 * or your custom domain once configured.
 */
function getPublicUrl(userHandle, slug) {
  const base =
    process.env.VERCEL_SITE_URL ||
    process.env.SITE_URL ||
    "https://vedicjourneys.vercel.app";

  return `${base.replace(/\/$/, "")}/u/${userHandle}/${slug}`;
}

module.exports = { commitAndPush, getPublicUrl };
