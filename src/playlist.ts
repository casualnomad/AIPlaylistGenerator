import { Ollama } from 'ollama';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchSimilar } from './embedder.js';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYLISTS_DIR = path.join(__dirname, '../playlists');

const ollama = new Ollama({ host: 'http://localhost:11434' });

// Change this to whatever chat model you have pulled in Ollama
export const CHAT_MODEL = 'Qwen2.5:7b';

interface TrackRow {
  id: number;
  file_path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  bpm: number | null;
  duration: number | null;
  metadata_text: string;
}

interface PlaylistEntry {
  track_id: number;
  reason: string;
}

interface OllamaPlaylistResponse {
  name: string;
  description: string;
  tracks: Array<{ id: number; reason: string }>;
}

function getTracksByIds(db: Database.Database, ids: number[]): TrackRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, file_path, title, artist, album, genre, year, bpm, duration, metadata_text
    FROM tracks WHERE id IN (${placeholders})
  `).all(...ids) as TrackRow[];
}

function tracksToPromptList(tracks: TrackRow[]): string {
  return tracks.map(t => {
    const parts = [`[ID:${t.id}]`];
    if (t.title)  parts.push(t.title);
    if (t.artist) parts.push(`by ${t.artist}`);
    if (t.album)  parts.push(`(${t.album})`);
    if (t.genre)  parts.push(`[${t.genre}]`);
    if (t.year)   parts.push(`${t.year}`);
    if (t.bpm)    parts.push(`${Math.round(t.bpm)}bpm`);
    return parts.join(' ');
  }).join('\n');
}

async function askOllama(prompt: string): Promise<string> {
  const response = await ollama.chat({
    model: CHAT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.7 },
  });
  return response.message.content;
}

function parseJsonFromResponse(text: string): unknown {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

/**
 * VIBE MODE: User describes a feeling, AI picks the best tracks.
 */
export async function generateVibePlaylist(
  db: Database.Database,
  prompt: string,
  size: number = 20
): Promise<void> {
  console.log(chalk.cyan(`\n🎵 Generating vibe playlist for: "${prompt}"\n`));

  const spinner = ora('Finding similar tracks via vector search...').start();

  // Step 1: vector search to find candidates
  const candidateIds = await searchSimilar(db, prompt, size * 3);
  const candidates = getTracksByIds(db, candidateIds);
  spinner.succeed(`Found ${candidates.length} candidate tracks`);

  if (candidates.length === 0) {
    console.log(chalk.red('No embedded tracks found. Run `npm run embed` first.'));
    return;
  }

  // Step 2: Ask Ollama to curate the final playlist
  const ollamaSpinner = ora(`Asking ${CHAT_MODEL} to curate...`).start();

  const aiPrompt = `You are a music curator. The user wants a playlist with this vibe: "${prompt}"

Here are candidate tracks (already pre-selected as relevant):
${tracksToPromptList(candidates)}

Select the best ${size} tracks for this playlist. Consider flow, variety, and how well each track fits the vibe.

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
  "name": "playlist name",
  "description": "one sentence description",
  "tracks": [
    { "id": <track_id>, "reason": "brief reason this track fits" },
    ...
  ]
}`;

  try {
    const raw = await askOllama(aiPrompt);
    console.log(chalk.gray('\n--- Mistral says ---\n') + raw + chalk.gray('\n---\n'));
    const result = parseJsonFromResponse(raw) as OllamaPlaylistResponse;
    ollamaSpinner.succeed('Playlist curated!');

    await savePlaylist(db, result, prompt, 'vibe');
  } catch (err) {
    ollamaSpinner.fail('Failed to parse AI response');
    console.error(chalk.red(String(err)));
  }
}

/**
 * CLUSTER MODE: AI analyzes your whole library and creates themed playlists.
 */
export async function generateClusters(
  db: Database.Database,
  count: number = 5
): Promise<void> {
  console.log(chalk.cyan(`\n🗂️  Auto-generating ${count} themed playlists from your library...\n`));

  // Sample tracks from the library (can't send all 50GB worth!)
  const sampleSize = Math.min(300, count * 60);
  const sample = db.prepare(`
    SELECT id, file_path, title, artist, album, genre, year, bpm, duration, metadata_text
    FROM tracks
    WHERE embedded = 1
    ORDER BY RANDOM()
    LIMIT ?
  `).all(sampleSize) as TrackRow[];

  if (sample.length === 0) {
    console.log(chalk.red('No embedded tracks found. Run `npm run embed` first.'));
    return;
  }

  console.log(chalk.gray(`Sampling ${sample.length} tracks for clustering...\n`));

  const spinner = ora(`Asking ${CHAT_MODEL} to find themes...`).start();

  const aiPrompt = `You are a music curator analyzing a music library. Below is a sample of tracks.

Your task: group these tracks into exactly ${count} themed playlists. Each playlist should have a distinct mood, genre, era, or vibe. Try to include 10-20 tracks per playlist.

Tracks:
${tracksToPromptList(sample)}

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "playlists": [
    {
      "name": "playlist name",
      "description": "one sentence description",
      "tracks": [
        { "id": <track_id>, "reason": "why this fits" },
        ...
      ]
    }
  ]
}`;

  try {
    const raw = await askOllama(aiPrompt);
    const result = parseJsonFromResponse(raw) as { playlists: OllamaPlaylistResponse[] };
    spinner.succeed(`Found ${result.playlists.length} themed clusters!`);

    for (const playlist of result.playlists) {
      await savePlaylist(db, playlist, undefined, 'cluster');
    }
  } catch (err) {
    spinner.fail('Failed to parse AI response');
    console.error(chalk.red(String(err)));
  }
}

async function savePlaylist(
  db: Database.Database,
  result: OllamaPlaylistResponse,
  prompt: string | undefined,
  type: 'vibe' | 'cluster'
): Promise<void> {
  // Save to DB
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO playlists (name, description, prompt, type)
    VALUES (?, ?, ?, ?)
  `).run(result.name, result.description, prompt ?? null, type);

  const insertTrack = db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, reason)
    VALUES (?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    result.tracks.forEach((t, i) => {
      insertTrack.run(lastInsertRowid, t.id, i + 1, t.reason);
    });
  });
  insertAll();

  // Export M3U
  await exportM3U(db, Number(lastInsertRowid), result.name);

  console.log(chalk.green(`\n✅ "${result.name}"`));
  console.log(chalk.gray(`   ${result.description}`));
  console.log(chalk.gray(`   ${result.tracks.length} tracks`));
}

async function exportM3U(db: Database.Database, playlistId: number, name: string): Promise<void> {
  const tracks = db.prepare(`
    SELECT t.file_path, t.title, t.artist, t.duration, pt.reason
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position
  `).all(playlistId) as Array<{
    file_path: string;
    title: string | null;
    artist: string | null;
    duration: number | null;
    reason: string | null;
  }>;

  const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filePath = path.join(PLAYLISTS_DIR, `${safeName}.m3u`);

  const lines = ['#EXTM3U', ''];
  for (const t of tracks) {
    const dur = t.duration ? Math.round(t.duration) : -1;
    const display = [t.artist, t.title].filter(Boolean).join(' - ') || t.file_path;
    if (t.reason) lines.push(`# ${t.reason}`);
    lines.push(`#EXTINF:${dur},${display}`);
    lines.push(t.file_path);
    lines.push('');
  }

  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'));
  console.log(chalk.blue(`   💾 Saved: playlists/${safeName}.m3u`));
}
