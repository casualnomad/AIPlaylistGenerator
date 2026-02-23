import { Ollama } from 'ollama';
import chalk from 'chalk';
import type Database from 'better-sqlite3';

const ollama = new Ollama({ host: 'http://localhost:11434' });

// Fast 3B model for summarization — keeps throughput high
const SUMMARY_MODEL = 'llama3.2:3b';

// Concurrent LRCLib requests — fast network bound step
const CONCURRENCY = 5;

interface TrackRow {
  id: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
}

// ─── LRCLib fetch ─────────────────────────────────────────────────────────────

async function fetchLyrics(track: TrackRow): Promise<string | null> {
  if (!track.title || !track.artist) return null;

  try {
    const params = new URLSearchParams({
      track_name:  track.title,
      artist_name: track.artist,
      ...(track.album    ? { album_name: track.album }                        : {}),
      ...(track.duration ? { duration:   String(Math.round(track.duration)) } : {}),
    });

    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { 'Lrclib-Client': 'music-ai/1.0 (local playlist generator)' },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      plainLyrics?:  string;
      syncedLyrics?: string;
      instrumental?: boolean;
    };

    if (data.instrumental) return 'INSTRUMENTAL';
    return data.plainLyrics ?? null;

  } catch {
    return null;
  }
}

// ─── LLM summarization (fast 3B model) ───────────────────────────────────────

async function summarizeLyrics(
  lyrics: string,
  title: string,
  artist: string
): Promise<string | null> {
  const truncated = lyrics.length > 3000
    ? lyrics.slice(0, 3000) + '\n[truncated]'
    : lyrics;

  const prompt = `Analyze these song lyrics and write a concise 1-2 sentence summary describing the main theme, emotional tone, and any notable imagery or narrative.

Song: "${title}" by ${artist}

Lyrics:
${truncated}

Write only the summary. No preamble, no quotes. Under 60 words.`;

  try {
    const response = await ollama.chat({
      model: SUMMARY_MODEL,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.3 },
    });
    const summary = response.message.content.trim();
    if (!summary || summary.length > 500) return null;
    return summary;
  } catch {
    return null;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchLyricsLibrary(
  db: Database.Database,
  options: { refetch?: boolean; limit?: number } = {}
): Promise<void> {

  // Add columns if missing (safe on existing DBs)
  const existingCols = new Set(
    (db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).map(r => r.name)
  );
  const colsToAdd: [string, string][] = [
    ['lyrics_raw',     'TEXT'],
    ['lyrics_summary', 'TEXT'],
    ['lyrics_fetched', 'INTEGER DEFAULT 0'],
  ];
  for (const [col, def] of colsToAdd) {
    if (!existingCols.has(col)) {
      db.prepare(`ALTER TABLE tracks ADD COLUMN ${col} ${def}`).run();
    }
  }

  // Build query
  const whereClause = options.refetch
    ? 'WHERE title IS NOT NULL AND artist IS NOT NULL'
    : 'WHERE (lyrics_fetched = 0 OR lyrics_fetched IS NULL) AND title IS NOT NULL AND artist IS NOT NULL';

  const limitClause = options.limit ? ` LIMIT ${options.limit}` : '';

  const tracks = db.prepare(`
    SELECT id, title, artist, album, duration
    FROM tracks
    ${whereClause}
    ORDER BY id
    ${limitClause}
  `).all() as TrackRow[];

  const total = tracks.length;

  if (total === 0) {
    console.log(chalk.green('✅ All tracks already have lyrics! Use --refetch to re-fetch.'));
    return;
  }

  console.log(chalk.cyan(`\n🎤 Fetching lyrics for ${total} tracks...`));
  console.log(chalk.gray(`   LRCLib fetch (${CONCURRENCY} concurrent) → raw storage + ${SUMMARY_MODEL} summary\n`));

  const updateTrack = db.prepare(`
    UPDATE tracks
    SET lyrics_raw = ?, lyrics_summary = ?, lyrics_fetched = 1
    WHERE id = ?
  `);

  let done     = 0;
  let found    = 0;
  let notFound = 0;
  let errors   = 0;

  function printProgress() {
    process.stdout.write(
      `\r  ${chalk.cyan(`[${done}/${total}]`)} ` +
      `${chalk.green(`✓ ${found}`)} found  ` +
      `${chalk.yellow(`✖ ${notFound}`)} not found  ` +
      `${chalk.red(`! ${errors}`)} errors   `
    );
  }

  async function processTrack(track: TrackRow): Promise<void> {
    const label = `${track.artist} — ${track.title}`;
    try {
      const lyrics = await fetchLyrics(track);

      if (!lyrics) {
        updateTrack.run(null, null, track.id);
        notFound++;
      } else if (lyrics === 'INSTRUMENTAL') {
        updateTrack.run(null, 'instrumental track, no lyrics', track.id);
        found++;
      } else {
        // Store raw (truncated to 1000 chars for embedding efficiency)
        const raw = lyrics.slice(0, 1000);
        // Summarize with fast 3B model
        const summary = await summarizeLyrics(lyrics, track.title!, track.artist!);
        updateTrack.run(raw, summary, track.id);
        found++;
        // Print summary on new line so it doesn't mess up progress
        if (summary) {
          process.stdout.write(`\n  ${chalk.green('✓')} ${chalk.bold(label)}\n`);
          process.stdout.write(`    ${chalk.gray('→ ' + summary)}\n`);
        }
      }
    } catch {
      updateTrack.run(null, null, track.id);
      errors++;
    }

    done++;
    printProgress();
  }

  // Run in concurrent batches
  for (let i = 0; i < tracks.length; i += CONCURRENCY) {
    const batch = tracks.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processTrack));
  }

  console.log(`\n\n${chalk.bold('✅ Lyrics fetch complete!')}`)
  console.log(`   Found:     ${chalk.green(found)}`);
  console.log(`   Not found: ${chalk.yellow(notFound)}`);
  console.log(`   Errors:    ${chalk.red(errors)}`);
  console.log(`\n${chalk.cyan("Run 'npm run retext && npm run embed' to update embeddings!")}`);
}