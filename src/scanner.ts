import * as mm from 'music-metadata';
import { glob } from 'glob';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import type Database from 'better-sqlite3';

// Supported audio formats
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'aac', 'm4a', 'ogg', 'wav', 'wv', 'ape', 'opus'];

/**
 * MusicBrainz folksonomy tags that describe artwork, packaging, or other
 * non-musical attributes — useless or harmful for vibe matching.
 */
const GENRE_BLOCKLIST = /\bon cover\b|\bcover\b|\bcolou?r\b|\bred\b|\bblue\b|\bblack\b|\bwhite\b|\bgreen\b|\byellow\b|\bpurple\b|\borange\b|\bpink\b|\bskull\b|\banimal\b|\bartwork\b|\bphotograph\b|\bfemale\b|\bmale\b|\bvocalist\b|\bsolo\b|\bgroup\b|\bband\b|\bloc:\b|\bconcept album\b|\blive\b|\bcompilation\b|\btribute\b|\bremix\b|\bcollection\b|\bsoundtrack\b/i;

export interface TrackMetadata {
  file_path: string;

  // Core
  title: string | null;
  artist: string | null;
  artists: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
  disk_no: number | null;
  year: number | null;
  duration: number | null;

  // Genre & mood
  genre: string | null;
  mood: string | null;

  // Musical attributes
  bpm: number | null;
  key: string | null;

  // Credits
  composer: string | null;
  lyricist: string | null;
  producer: string | null;
  engineer: string | null;
  mixer: string | null;
  remixer: string | null;

  // Release info
  label: string | null;
  catalog_no: string | null;
  isrc: string | null;
  media: string | null;
  release_country: string | null;

  // Freetext
  comment: string | null;
  language: string | null;

  // MusicBrainz
  mb_track_id: string | null;
  mb_artist_id: string | null;
  mb_album_id: string | null;

  metadata_text: string;
}

/** Join an array of strings into a semicolon-separated string, filtering nulls */
function joinArr(arr: (string | null | undefined)[] | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  const filtered = arr.filter((s): s is string => !!s);
  return filtered.length > 0 ? filtered.join('; ') : null;
}

/** Filter out MusicBrainz folksonomy noise from genre lists */
function filterGenres(genres: string[]): string[] {
  return genres.filter(g => g && !GENRE_BLOCKLIST.test(g.trim()));
}

/**
 * Build a rich text blob from metadata — this is what gets embedded.
 * The more descriptive, the better the vector search results.
 */
function buildMetadataText(meta: Omit<TrackMetadata, 'metadata_text'>): string {
  const parts: string[] = [];

  if (meta.title)          parts.push(`Title: ${meta.title}`);
  if (meta.artist)         parts.push(`Artist: ${meta.artist}`);
  if (meta.artists && meta.artists !== meta.artist)
                           parts.push(`Featured Artists: ${meta.artists}`);
  if (meta.album)          parts.push(`Album: ${meta.album}`);
  if (meta.album_artist && meta.album_artist !== meta.artist)
                           parts.push(`Album Artist: ${meta.album_artist}`);
  if (meta.year)           parts.push(`Year: ${meta.year}`);
  if (meta.genre)          parts.push(`Genre: ${meta.genre}`);
  if (meta.mood)           parts.push(`Mood: ${meta.mood}`);
  if (meta.bpm)            parts.push(`BPM: ${Math.round(meta.bpm)}`);
  if (meta.key)            parts.push(`Key: ${meta.key}`);
  if (meta.duration)       parts.push(`Duration: ${Math.round(meta.duration)}s`);
  if (meta.composer)       parts.push(`Composer: ${meta.composer}`);
  if (meta.lyricist)       parts.push(`Lyricist: ${meta.lyricist}`);
  if (meta.producer)       parts.push(`Producer: ${meta.producer}`);
  if (meta.engineer)       parts.push(`Engineer: ${meta.engineer}`);
  if (meta.mixer)          parts.push(`Mixer: ${meta.mixer}`);
  if (meta.remixer)        parts.push(`Remixer: ${meta.remixer}`);
  if (meta.label)          parts.push(`Label: ${meta.label}`);
  if (meta.catalog_no)     parts.push(`Catalog: ${meta.catalog_no}`);
  if (meta.media)          parts.push(`Media: ${meta.media}`);
  if (meta.release_country) parts.push(`Country: ${meta.release_country}`);
  if (meta.language)       parts.push(`Language: ${meta.language}`);
  if (meta.comment)        parts.push(`Comment: ${meta.comment}`);

  // Fallback: use filename if no title
  if (!meta.title) {
    const filename = path.basename(meta.file_path, path.extname(meta.file_path));
    parts.push(`Filename: ${filename}`);
  }

  return parts.join('. ');
}

async function extractMetadata(filePath: string): Promise<TrackMetadata | null> {
  try {
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: true });
    const { common, format } = meta;
    const nativeTags = meta.native;

    /** Get the first matching native tag value */
    function getNative(keys: string[]): string | null {
      for (const [, tags] of Object.entries(nativeTags)) {
        for (const key of keys) {
          const found = tags.find(t => t.id.toLowerCase() === key.toLowerCase());
          if (found?.value) return String(found.value);
        }
      }
      return null;
    }

    /** Get ALL matching native tag values joined as a semicolon string */
    function getAllNative(keys: string[]): string | null {
      const values: string[] = [];
      for (const [, tags] of Object.entries(nativeTags)) {
        for (const key of keys) {
          tags
            .filter(t => t.id.toLowerCase() === key.toLowerCase())
            .forEach(t => { if (t.value) values.push(String(t.value)); });
        }
      }
      return values.length > 0 ? [...new Set(values)].join('; ') : null;
    }

    // All genres: standard common.genre + Picard's custom ab:genre tags
    // Filter out MusicBrainz folksonomy noise (artwork descriptors, colors, etc.)
    const allGenres = [
      ...(common.genre ?? []),
      ...(getAllNative(['----:com.apple.iTunes:ab:genre', 'ab:genre', 'TXXX:ab:genre'])?.split('; ') ?? []),
    ];
    const genre = joinArr(filterGenres([...new Set(allGenres)]));

    // Mood: standard field + Picard's custom ab:mood tags
    const mood =
      joinArr((common as any).mood ? [(common as any).mood] : undefined) ??
      getAllNative([
        'TMOO',
        'MOOD',
        '----:com.apple.iTunes:MOOD',
        '----:com.apple.iTunes:ab:mood',
        'WM/Mood',
        'ab:mood',
        'TXXX:ab:mood',
      ]);

    // Musical key
    const key =
      (common as any).key ??
      getNative(['TKEY', 'INITIALKEY', '----:com.apple.iTunes:initialkey', 'WM/InitialKey']);

    // Credits — pull from common where available, fall back to native tags
    const producer =
      joinArr((common as any).producer) ??
      getAllNative(['TIPL:producer', 'IPLS:producer', '----:com.apple.iTunes:PRODUCER', 'WM/Producer']);

    const engineer =
      joinArr((common as any).engineer) ??
      getAllNative(['TIPL:engineer', 'IPLS:engineer', '----:com.apple.iTunes:ENGINEER']);

    const mixer =
      joinArr((common as any).mixer) ??
      getAllNative(['TIPL:mixer', 'IPLS:mixer', '----:com.apple.iTunes:MIXER']);

    const base: Omit<TrackMetadata, 'metadata_text'> = {
      file_path:        filePath,
      title:            common.title          ?? null,
      artist:           common.artist         ?? null,
      artists:          joinArr(common.artists),
      album:            common.album          ?? null,
      album_artist:     common.albumartist    ?? null,
      track_no:         common.track?.no      ?? null,
      disk_no:          common.disk?.no       ?? null,
      year:             common.year           ?? null,
      duration:         format.duration       ?? null,
      genre,
      mood,
      bpm:              common.bpm            ?? null,
      key,
      composer:         joinArr(common.composer),
      lyricist:         joinArr(common.lyricist),
      producer,
      engineer,
      mixer,
      remixer:          joinArr(common.remixer),
      label:            joinArr(common.label),
      catalog_no:       joinArr(common.catalognumber),
      isrc:             joinArr(common.isrc),
      media:            common.media          ?? null,
      release_country:  common.releasecountry ?? null,
      comment:          common.comment?.[0]   ?? null,
      language:         common.language       ?? null,
      mb_track_id:      common.musicbrainz_recordingid ?? null,
      mb_artist_id:     joinArr(common.musicbrainz_artistid),
      mb_album_id:      common.musicbrainz_albumid ?? null,
    };

    return { ...base, metadata_text: buildMetadataText(base) };
  } catch {
    // Silently skip unreadable files
    return null;
  }
}

export async function scanLibrary(db: Database.Database, musicDir: string): Promise<void> {
  const spinner = ora('Finding audio files...').start();

  const pattern = `${musicDir}/**/*.{${AUDIO_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, { nocase: true });

  spinner.succeed(`Found ${chalk.bold(files.length)} audio files`);

  if (files.length === 0) {
    console.log(chalk.yellow('No audio files found. Check your music directory path.'));
    return;
  }

  const insert = db.prepare(`
    INSERT INTO tracks (
      file_path, title, artist, artists, album, album_artist, track_no, disk_no,
      year, duration, genre, mood, bpm, key, composer, lyricist, producer,
      engineer, mixer, remixer, label, catalog_no, isrc, media,
      release_country, comment, language, mb_track_id, mb_artist_id,
      mb_album_id, metadata_text
    )
    VALUES (
      @file_path, @title, @artist, @artists, @album, @album_artist, @track_no, @disk_no,
      @year, @duration, @genre, @mood, @bpm, @key, @composer, @lyricist, @producer,
      @engineer, @mixer, @remixer, @label, @catalog_no, @isrc, @media,
      @release_country, @comment, @language, @mb_track_id, @mb_artist_id,
      @mb_album_id, @metadata_text
    )
    ON CONFLICT(file_path) DO UPDATE SET
      title           = excluded.title,
      artist          = excluded.artist,
      artists         = excluded.artists,
      album           = excluded.album,
      album_artist    = excluded.album_artist,
      track_no        = excluded.track_no,
      disk_no         = excluded.disk_no,
      year            = excluded.year,
      duration        = excluded.duration,
      genre           = excluded.genre,
      mood            = excluded.mood,
      bpm             = excluded.bpm,
      key             = excluded.key,
      composer        = excluded.composer,
      lyricist        = excluded.lyricist,
      producer        = excluded.producer,
      engineer        = excluded.engineer,
      mixer           = excluded.mixer,
      remixer         = excluded.remixer,
      label           = excluded.label,
      catalog_no      = excluded.catalog_no,
      isrc            = excluded.isrc,
      media           = excluded.media,
      release_country = excluded.release_country,
      comment         = excluded.comment,
      language        = excluded.language,
      mb_track_id     = excluded.mb_track_id,
      mb_artist_id    = excluded.mb_artist_id,
      mb_album_id     = excluded.mb_album_id,
      metadata_text   = excluded.metadata_text,
      embedded        = CASE WHEN metadata_text != excluded.metadata_text THEN 0 ELSE embedded END,
      scanned_at      = unixepoch()
  `);

  const insertMany = db.transaction((tracks: TrackMetadata[]) => {
    for (const track of tracks) {
      insert.run(track);
    }
  });

  const BATCH_SIZE = 200;
  let processed = 0;
  let failed = 0;
  let batch: TrackMetadata[] = [];

  const scanSpinner = ora(`Scanning metadata... 0/${files.length}`).start();

  for (const file of files) {
    const meta = await extractMetadata(file);
    if (meta) {
      batch.push(meta);
    } else {
      failed++;
    }

    processed++;

    if (batch.length >= BATCH_SIZE) {
      insertMany(batch);
      batch = [];
    }

    if (processed % 100 === 0) {
      scanSpinner.text = `Scanning metadata... ${processed}/${files.length}`;
    }
  }

  if (batch.length > 0) {
    insertMany(batch);
  }

  scanSpinner.succeed(
    `Scanned ${chalk.green(processed - failed)} tracks` +
    (failed > 0 ? chalk.yellow(` (${failed} skipped)`) : '')
  );

  const total = (db.prepare('SELECT COUNT(*) as count FROM tracks').get() as { count: number }).count;
  console.log(chalk.cyan(`📚 Library total: ${total} tracks`));
}