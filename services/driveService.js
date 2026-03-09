// services/driveService.js
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const TOKEN_PATH = path.join(__dirname, "../token.json");
const CREDENTIALS_PATH = path.join(__dirname, "../credentials.json");

async function getDriveClient() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } =
    credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oAuth2Client.setCredentials(token);

  return google.drive({ version: "v3", auth: oAuth2Client });
}

async function listRecentImages(drive, limit = 10) {
  const res = await drive.files.list({
    q: "mimeType contains 'image/' and trashed = false",
    orderBy: "createdTime desc",
    pageSize: limit,
    fields: "files(id, name, mimeType, createdTime)"
  });

  return res.data.files;
}

async function downloadImage(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function getFolderId(drive, folderName, parentId = null) {
  let query = `mimeType = 'application/vnd.google-apps.folder' 
               and name = '${folderName}' 
               and trashed = false`;

  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name)"
  });

  if (res.data.files.length === 0) {
    throw new Error(`Folder not found: ${folderName}`);
  }

  return res.data.files[0].id;
}

async function getFolderId(drive, folderName, parentId = null) {
  let query = `mimeType = 'application/vnd.google-apps.folder' 
               and name = '${folderName}' 
               and trashed = false`;

  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name)"
  });

  if (res.data.files.length === 0) {
    throw new Error(`Folder not found: ${folderName}`);
  }

  return res.data.files[0].id;
}

async function listImagesInFolder(drive, folderId, limit = 10) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents 
        and mimeType contains 'image/' 
        and trashed = false`,
    orderBy: "createdTime desc",
    pageSize: limit,
    fields: "files(id, name, mimeType, createdTime)"
  });

  return res.data.files;
}

async function moveFile(drive, fileId, newFolderId) {
  const file = await drive.files.get({
    fileId,
    fields: "parents"
  });

  const previousParents = file.data.parents.join(",");

  await drive.files.update({
    fileId,
    addParents: newFolderId,
    removeParents: previousParents
  });
}

async function listSubfolders(drive, parentFolderId) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents 
        and mimeType = 'application/vnd.google-apps.folder' 
        and trashed = false`,
    fields: "files(id, name)"
  });

  return res.data.files;
}

async function moveFolder(drive, folderId, newParentId) {
  const folder = await drive.files.get({
    fileId: folderId,
    fields: "parents"
  });

  const previousParents = folder.data.parents.join(",");

  await drive.files.update({
    fileId: folderId,
    addParents: newParentId,
    removeParents: previousParents
  });
}

const stream = require("stream");

async function uploadMarkdown(drive, content, filename, parentFolderId) {
  const bufferStream = new stream.PassThrough();
  bufferStream.end(Buffer.from(content));

  const fileMetadata = {
    name: filename,
    mimeType: "text/markdown",
    parents: [parentFolderId]   // <-- CRITICAL FIX
  };

  const media = {
    mimeType: "text/markdown",
    body: bufferStream
  };

  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: "id"
  });

  return file.data.id;
}

/**
 * Gets a folder by name under parentId, creating it if it doesn't exist.
 * Used for the /review folder which may not exist on first run.
 */
async function ensureFolder(drive, folderName, parentId) {
  let query = `mimeType = 'application/vnd.google-apps.folder' and name = '${folderName}' and trashed = false`;
  if (parentId) query += ` and '${parentId}' in parents`;

  const res = await drive.files.list({ q: query, fields: "files(id, name)" });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // Create it
  const fileMetadata = {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
    ...(parentId ? { parents: [parentId] } : {}),
  };

  const folder = await drive.files.create({
    resource: fileMetadata,
    fields: "id",
  });

  console.log(`📁 Created Drive folder: /${folderName}`);
  return folder.data.id;
}

module.exports = {
  getDriveClient,
  listRecentImages,
  listImagesInFolder,
  listSubfolders,
  downloadImage,
  uploadMarkdown,
  moveFile,
  moveFolder,
  getFolderId,
  ensureFolder,
};
