const exif = require("exif-parser");

function extractExif(buffer) {
  try {
    const parser = exif.create(buffer);
    const result = parser.parse();

    const tags = result.tags || {};

    return {
      dateTaken: tags.DateTimeOriginal
        ? new Date(tags.DateTimeOriginal * 1000)
        : null,
      latitude: tags.GPSLatitude || null,
      longitude: tags.GPSLongitude || null,
      altitude: tags.GPSAltitude || null,
      cameraModel: tags.Model || null,
      raw: tags
    };
  } catch (err) {
    return null;
  }
}

module.exports = { extractExif };