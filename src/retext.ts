import type Database from 'better-sqlite3';
import chalk from 'chalk';
import ora from 'ora';

interface FullTrack {
  id: number;
  // metadata fields
  title: string | null;
  artist: string | null;
  artists: string | null;
  album: string | null;
  album_artist: string | null;
  year: number | null;
  genre: string | null;
  mood: string | null;
  bpm: number | null;
  key: string | null;
  duration: number | null;
  composer: string | null;
  lyricist: string | null;
  producer: string | null;
  engineer: string | null;
  mixer: string | null;
  remixer: string | null;
  label: string | null;
  media: string | null;
  release_country: string | null;
  comment: string | null;
  language: string | null;
  // essentia fields
  bpm_essentia: number | null;
  key_essentia: string | null;
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  speechiness: number | null;
  loudness: number | null;
}

function buildFullMetadataText(t: FullTrack): string {
  const parts: string[] = [];

  if (t.title)        parts.push(`Title: ${t.title}`);
  if (t.artist)       parts.push(`Artist: ${t.artist}`);
  if (t.artists && t.artists !== t.artist)
                      parts.push(`Featured Artists: ${t.artists}`);
  if (t.album)        parts.push(`Album: ${t.album}`);
  if (t.album_artist && t.album_artist !== t.artist)
                      parts.push(`Album Artist: ${t.album_artist}`);
  if (t.year)         parts.push(`Year: ${t.year}`);
  if (t.genre)        parts.push(`Genre: ${t.genre}`);
  if (t.mood)         parts.push(`Mood: ${t.mood}`);

  // Prefer Essentia BPM over tag BPM as it's more accurate
  const bpm = t.bpm_essentia ?? t.bpm;
  if (bpm)            parts.push(`BPM: ${Math.round(bpm)}`);

  // Prefer Essentia key
  const key = t.key_essentia ?? t.key;
  if (key)            parts.push(`Key: ${key}`);

  if (t.duration)     parts.push(`Duration: ${Math.round(t.duration)}s`);
  if (t.composer)     parts.push(`Composer: ${t.composer}`);
  if (t.lyricist)     parts.push(`Lyricist: ${t.lyricist}`);
  if (t.producer)     parts.push(`Producer: ${t.producer}`);
  if (t.engineer)     parts.push(`Engineer: ${t.engineer}`);
  if (t.mixer)        parts.push(`Mixer: ${t.mixer}`);
  if (t.remixer)      parts.push(`Remixer: ${t.remixer}`);
  if (t.label)        parts.push(`Label: ${t.label}`);
  if (t.media)        parts.push(`Media: ${t.media}`);
  if (t.release_country) parts.push(`Country: ${t.release_country}`);
  if (t.language)     parts.push(`Language: ${t.language}`);
  if (t.comment)      parts.push(`Comment: ${t.comment}`);

  // Acoustic features — describe them in natural language for better embedding
  if (t.energy !== null)           parts.push(`Energy: ${describeScale(t.energy, ['very low', 'low', 'moderate', 'high', 'very high'])}`);
  if (t.valence !== null)          parts.push(`Valence: ${describeScale(t.valence, ['very sad', 'sad', 'neutral', 'happy', 'very happy'])}`);
  if (t.danceability !== null)     parts.push(`Danceability: ${describeScale(t.danceability, ['not danceable', 'low danceability', 'moderately danceable', 'danceable', 'very danceable'])}`);
  if (t.acousticness !== null)     parts.push(`Acousticness: ${describeScale(t.acousticness, ['electronic', 'mostly electronic', 'mixed', 'mostly acoustic', 'acoustic'])}`);
  if (t.instrumentalness !== null) parts.push(`Instrumentalness: ${describeScale(t.instrumentalness, ['has vocals', 'mostly vocals', 'mixed', 'mostly instrumental', 'instrumental'])}`);
  if (t.speechiness !== null)      parts.push(`Speechiness: ${describeScale(t.speechiness, ['no speech', 'some speech', 'moderate speech', 'mostly speech', 'spoken word'])}`);
  if (t.loudness !== null)         parts.push(`Loudness: ${t.loudness.toFixed(1)} LUFS`);

  return parts.join('. ');
}

/** Map a 0-1 value to a descriptive label */
function describeScale(value: number, labels: [string, string, string, string, string]): string {
  const index = Math.min(4, Math.floor(value * 5));
  return labels[index];
}

export async function retextLibrary(db: Database.Database): Promise<void> {
  const spinner = ora('Rebuilding metadata text with acoustic features...').start();

  const tracks = db.prepare(`
    SELECT id, title, artist, artists, album, album_artist, year, genre, mood,
           bpm, key, duration, composer, lyricist, producer, engineer, mixer,
           remixer, label, media, release_country, comment, language,
           bpm_essentia, key_essentia, energy, valence, danceability,
           acousticness, instrumentalness, speechiness, loudness
    FROM tracks
  `).all() as FullTrack[];

  spinner.succeed(`Rebuilding ${chalk.bold(tracks.length)} tracks`);

  const update = db.prepare(`
    UPDATE tracks
    SET metadata_text = ?, embedded = 0
    WHERE id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const track of tracks) {
      const text = buildFullMetadataText(track);
      update.run(text, track.id);
    }
  });

  updateAll();

  console.log(chalk.green(`✅ Metadata text rebuilt for ${tracks.length} tracks`));
  console.log(chalk.cyan(`   Run 'npm run embed' to re-embed with acoustic features`));
}