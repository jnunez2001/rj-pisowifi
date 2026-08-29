// ===== LOCAL MOVIE SERVER =====
// Scans an operator-chosen folder (settings.movies_source_dir) for video
// files and serves them to customers over HLS (HTTP Live Streaming) -
// browsers can't play MKV/AVI/etc directly, so each movie gets
// transcoded ONCE (not per-viewer) into a segmented, browser-native
// stream cached under public/movies_cache/<id>/, then reused for every
// future view. Gating (free = active WiFi session, premium = paid
// per-device rental) lives in server/routes/movies.js, this file only
// handles the filesystem/ffmpeg side.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);
const CACHE_DIR = path.join(__dirname, '../../public/movies_cache');

// id -> true while a transcode is actively running, so a second request
// for the same movie (e.g. two customers clicking Play close together)
// doesn't start a duplicate ffmpeg process.
const activeTranscodes = new Set();

function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function checkFfmpeg() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => resolve(!err));
  });
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ], (err, stdout) => {
      const seconds = parseFloat(stdout);
      resolve(Number.isFinite(seconds) ? Math.round(seconds) : null);
    });
  });
}

// Scans movies_source_dir for video files not already in the movies
// table. Doesn't transcode anything itself - that happens lazily
// (transcodeMovie) the first time a customer actually tries to play a
// given title, so adding 200 movies to the folder doesn't mean 200
// ffmpeg jobs kick off at once.
async function scanMoviesFolder() {
  const dir = getSetting('movies_source_dir');
  if (!dir) return { success: false, message: 'No movies folder configured' };
  if (!fs.existsSync(dir)) return { success: false, message: `Folder not found: ${dir}` };

  const existing = new Set(db.prepare('SELECT filename FROM movies').all().map((m) => m.filename));
  const files = fs.readdirSync(dir).filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()));

  const insert = db.prepare('INSERT INTO movies (filename, title) VALUES (?, ?)');
  let added = 0;
  for (const file of files) {
    if (existing.has(file)) continue;
    const title = path.basename(file, path.extname(file)).replace(/[._]/g, ' ').trim();
    insert.run(file, title);
    added++;
  }
  return { success: true, added, total: files.length };
}

function getMovies() {
  return db.prepare('SELECT * FROM movies ORDER BY added_at DESC').all();
}

function getMovie(id) {
  return db.prepare('SELECT * FROM movies WHERE id = ?').get(id);
}

function movieCacheDir(id) {
  return path.join(CACHE_DIR, String(id));
}

// Kicks off (or joins, if already running) the background ffmpeg job
// that produces this movie's HLS playlist + segments + thumbnail. Never
// blocks the caller - the route handler just reports status ('ready',
// 'transcoding', or 'starting') and the customer's player polls/retries.
function ensureTranscoded(id) {
  const movie = getMovie(id);
  if (!movie) return;
  if (movie.status === 'ready' || activeTranscodes.has(id)) return;

  const dir = getSetting('movies_source_dir');
  const inputPath = path.join(dir, movie.filename);
  if (!fs.existsSync(inputPath)) {
    db.prepare("UPDATE movies SET status = 'failed' WHERE id = ?").run(id);
    return;
  }

  activeTranscodes.add(id);
  db.prepare("UPDATE movies SET status = 'transcoding' WHERE id = ?").run(id);

  const outDir = movieCacheDir(id);
  fs.mkdirSync(outDir, { recursive: true });
  const playlistPath = path.join(outDir, 'master.m3u8');
  const thumbPath = path.join(outDir, 'thumb.jpg');

  probeDuration(inputPath).then((duration) => {
    if (duration) db.prepare('UPDATE movies SET duration_seconds = ? WHERE id = ?').run(duration, id);

    // Thumbnail: grab a frame a few seconds in (safe even for very short
    // clips), best-effort - a failed thumbnail shouldn't fail the whole
    // transcode.
    execFile('ffmpeg', [
      '-ss', '5', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=400:-1', '-y', thumbPath
    ], () => {
      if (fs.existsSync(thumbPath)) {
        db.prepare('UPDATE movies SET thumbnail_path = ? WHERE id = ?').run(`/movies_cache/${id}/thumb.jpg`, id);
      }
    });

    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      // ultrafast trades a somewhat larger output file for much lower
      // CPU/RAM pressure during encoding - the right call on weak
      // hardware (e.g. a Celeron N4000/N4100), where this is a one-time
      // per-movie cost anyway (cached after), not something that needs
      // to be fast, just something that needs to not choke the box.
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-vf', 'scale=-2:720',
      '-c:a', 'aac', '-b:a', '128k',
      '-hls_time', '6', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
      '-y', playlistPath
    ]);

    ffmpeg.on('close', (code) => {
      activeTranscodes.delete(id);
      if (code === 0 && fs.existsSync(playlistPath)) {
        db.prepare("UPDATE movies SET status = 'ready' WHERE id = ?").run(id);
      } else {
        db.prepare("UPDATE movies SET status = 'failed' WHERE id = ?").run(id);
        console.error(`[Movies] Transcode failed for movie ${id} (exit ${code})`);
      }
    });
    ffmpeg.on('error', () => {
      activeTranscodes.delete(id);
      db.prepare("UPDATE movies SET status = 'failed' WHERE id = ?").run(id);
    });
  });
}

function deleteMovie(id) {
  db.prepare('DELETE FROM movie_rentals WHERE movie_id = ?').run(id);
  db.prepare('DELETE FROM movies WHERE id = ?').run(id);
  const dir = movieCacheDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  checkFfmpeg, scanMoviesFolder, getMovies, getMovie,
  ensureTranscoded, movieCacheDir, deleteMovie
};
