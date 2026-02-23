import type Database from 'better-sqlite3';
import chalk from 'chalk';
import ora from 'ora';

interface FullTrack {
  id: number;
  // Core metadata
  title: string | null;
  artist: string | null;
  artists: string | null;
  album: string | null;
  album_artist: string | null;
  year: number | null;
  original_year: number | null;
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
  // Essentia acoustic features
  bpm_essentia: number | null;
  key_essentia: string | null;
  key_strength: number | null;
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  speechiness: number | null;
  loudness: number | null;
  spectral_centroid: number | null;
  spectral_flux: number | null;
  zero_crossing_rate: number | null;
  // Lyrics
  lyrics_summary: string | null;
  lyrics_raw: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tier<T>(value: number, thresholds: [number, T][], fallback: T): T {
  for (const [threshold, label] of thresholds) {
    if (value >= threshold) return label;
  }
  return fallback;
}

// ─── Feature descriptions ────────────────────────────────────────────────────

function describeEnergy(e: number): string {
  return tier(e, [
    [0.85, 'explosive, relentless, intense energy'],
    [0.70, 'high energy, driving, powerful'],
    [0.55, 'energetic, lively'],
    [0.40, 'moderate energy, balanced'],
    [0.25, 'laid back, relaxed, low energy'],
    [0.10, 'calm, gentle, minimal energy'],
  ], 'near-silent, ambient, barely there');
}

function describeValence(v: number): string {
  return tier(v, [
    [0.85, 'euphoric, joyful, uplifting, celebratory'],
    [0.70, 'happy, positive, feel-good, optimistic'],
    [0.55, 'content, light, pleasant'],
    [0.40, 'neutral, bittersweet, ambiguous emotion'],
    [0.25, 'melancholic, wistful, somber, sad'],
    [0.10, 'dark, brooding, heavy, depressing'],
  ], 'desolate, bleak, deeply sorrowful');
}

function describeDanceability(d: number): string {
  return tier(d, [
    [0.85, 'made for the dancefloor, irresistibly danceable, strong groove'],
    [0.70, 'very danceable, infectious rhythm, great groove'],
    [0.55, 'danceable, rhythmically engaging'],
    [0.40, 'moderate groove, some rhythmic drive'],
    [0.25, 'not very danceable, loose or irregular rhythm'],
    [0.10, 'arrhythmic, hard to dance to'],
  ], 'no discernible groove or rhythm');
}

function describeAcousticness(a: number): string {
  return tier(a, [
    [0.85, 'fully acoustic, organic, raw, unplugged'],
    [0.70, 'mostly acoustic, natural sound with light production'],
    [0.55, 'acoustic-leaning, some electronic elements'],
    [0.40, 'blend of acoustic and electronic'],
    [0.25, 'mostly electronic, heavily produced'],
    [0.10, 'fully electronic, synthetic, studio-constructed'],
  ], 'entirely synthetic, machine-made sound');
}

function describeInstrumentalness(i: number): string {
  return tier(i, [
    [0.85, 'fully instrumental, no vocals whatsoever'],
    [0.70, 'mostly instrumental, vocals are minimal or incidental'],
    [0.55, 'instrumental with some vocal elements'],
    [0.40, 'roughly equal mix of instrumental and vocals'],
    [0.25, 'vocal-led but with strong instrumental passages'],
    [0.10, 'strongly vocal-driven, lyrics are front and center'],
  ], 'entirely vocal, spoken word or a cappella');
}

function describeSpeechiness(s: number): string {
  return tier(s, [
    [0.80, 'spoken word, audiobook, podcast, or very heavy rap'],
    [0.60, 'rap or hip hop, lots of rapid speech'],
    [0.40, 'mix of rapping or speaking and singing'],
    [0.20, 'some spoken elements or rap sections'],
    [0.10, 'predominantly sung vocals'],
  ], 'purely sung, no speech');
}

function describeTempo(bpm: number): string {
  const feel = tier(bpm, [
    [180, 'frantic, breakneck pace'],
    [160, 'very fast, urgent'],
    [140, 'fast, driving'],
    [120, 'upbeat, energetic pace'],
    [100, 'moderate, steady'],
    [80,  'relaxed, unhurried'],
    [60,  'slow, languid'],
  ], 'extremely slow, meditative');
  return `${Math.round(bpm)} BPM — ${feel}`;
}

function describeKey(keyStr: string, strength: number | null): string {
  const isMinor = keyStr.toLowerCase().includes('minor');
  const tonalCharacter = isMinor
    ? 'minor key — tends toward darker, more emotional, introspective, or tense character'
    : 'major key — tends toward brighter, more uplifting, resolved, or triumphant character';

  const strengthDesc = strength !== null
    ? tier(strength, [
        [0.85, 'very strong tonal center, harmonically clear'],
        [0.65, 'clear tonal center'],
        [0.45, 'moderate tonal ambiguity'],
        [0.25, 'weak tonal center, harmonically ambiguous'],
      ], 'atonal or highly chromatic')
    : null;

  return strengthDesc
    ? `${keyStr} — ${tonalCharacter}, ${strengthDesc}`
    : `${keyStr} — ${tonalCharacter}`;
}

function describeLoudness(l: number): string {
  const lufs = l.toFixed(1);
  const desc = tier(l, [
    [-6,  'extremely loud, heavily brick-walled, loud-war mastering'],
    [-9,  'very loud, modern aggressive mastering'],
    [-12, 'loud, punchy, modern mastering'],
    [-14, 'moderate loudness, balanced dynamic range'],
    [-18, 'quiet, good dynamic range'],
    [-23, 'very quiet, highly dynamic, audiophile mastering'],
  ], 'extremely quiet, minimal or ambient');
  return `${lufs} LUFS — ${desc}`;
}

function describeBrightness(centroid: number): string {
  // Spectral centroid in Hz — typical range 500–4000Hz for music
  return tier(centroid, [
    [3500, 'very bright, sharp, trebly, cutting'],
    [2500, 'bright, crisp, present'],
    [1800, 'balanced brightness, clear midrange'],
    [1200, 'warm, slightly dark'],
    [700,  'dark, warm, full-bodied'],
  ], 'very dark, heavy low-end, muddy or bass-heavy');
}

function describeDynamism(flux: number): string {
  // Spectral flux — how much the spectrum changes frame to frame
  return tier(flux, [
    [0.5,  'highly dynamic, constantly evolving texture'],
    [0.3,  'varied, interesting texture changes'],
    [0.15, 'moderate variation, some texture movement'],
    [0.05, 'fairly static texture, consistent sound'],
  ], 'droney, hypnotic, near-static texture');
}

function describeGrit(zcr: number): string {
  // Zero crossing rate — proxy for noise/distortion
  return tier(zcr, [
    [0.15, 'very gritty, heavily distorted, noisy, raw'],
    [0.10, 'some grit or distortion, rough edges'],
    [0.06, 'clean with character, slight roughness'],
    [0.03, 'clean, polished sound'],
  ], 'pristine, very clean, smooth production');
}

// ─── Emotional arc synthesis ─────────────────────────────────────────────────

function synthesizeEmotionalArc(t: FullTrack): string | null {
  if (t.energy === null || t.valence === null) return null;

  const e = t.energy;
  const v = t.valence;
  const isMinor = t.key_essentia?.toLowerCase().includes('minor') ?? false;
  const isInstrumental = (t.instrumentalness ?? 0) > 0.6;

  // Quadrant-based emotional synthesis
  if (e > 0.6 && v > 0.6) {
    return isInstrumental
      ? 'Overall feel: triumphant, euphoric, high-energy — great for workouts, celebrations, peak moments'
      : 'Overall feel: anthemic, feel-good, celebratory — high energy and happy';
  }
  if (e > 0.6 && v < 0.4) {
    return isMinor
      ? 'Overall feel: aggressive, intense, dark energy — angry, powerful, confrontational'
      : 'Overall feel: driving, urgent, tense — high energy but emotionally heavy';
  }
  if (e < 0.4 && v > 0.6) {
    return 'Overall feel: gentle and uplifting, peaceful happiness — good for mornings, unwinding, background warmth';
  }
  if (e < 0.4 && v < 0.4) {
    return isMinor
      ? 'Overall feel: melancholic and introspective, quiet sadness — late night, solitary, reflective'
      : 'Overall feel: calm and pensive, understated emotion — quiet and thoughtful';
  }
  if (e > 0.5 && v > 0.4 && v < 0.6) {
    return 'Overall feel: energetic but emotionally complex, bittersweet drive';
  }

  return 'Overall feel: balanced, versatile, sits comfortably across moods';
}

// ─── Sound profile synthesis ──────────────────────────────────────────────────

function synthesizeSoundProfile(t: FullTrack): string | null {
  if (t.acousticness === null || t.instrumentalness === null) return null;

  const a = t.acousticness;
  const i = t.instrumentalness;
  const s = t.speechiness ?? 0;

  if (s > 0.6)  return `Sound profile: rap or spoken word — ${a > 0.5 ? 'organic, live feel' : 'electronic or produced beat'}`;
  if (a > 0.7 && i > 0.7) return 'Sound profile: acoustic instrumental — think classical, jazz, folk guitar, unplugged';
  if (a > 0.7 && i < 0.4) return 'Sound profile: acoustic vocal — singer-songwriter, folk, acoustic pop';
  if (a < 0.3 && i > 0.7) return 'Sound profile: electronic instrumental — ambient, EDM, film score, synth';
  if (a < 0.3 && i < 0.4) return 'Sound profile: electronic vocal — pop, synth-pop, electronic with lead vocals';
  if (a > 0.4 && a < 0.7 && i > 0.5) return 'Sound profile: hybrid instrumental — mixed acoustic and electronic elements';
  if (a > 0.4 && a < 0.7 && i < 0.5) return 'Sound profile: band or ensemble with vocals — rock, indie, soul, hybrid production';

  return null;
}

// ─── Main metadata text builder ───────────────────────────────────────────────

function buildFullMetadataText(t: FullTrack): string {
  const parts: string[] = [];

  // ── Core identity ──
  if (t.title)   parts.push(`Title: ${t.title}`);
  if (t.artist)  parts.push(`Artist: ${t.artist}`);
  if (t.artists && t.artists !== t.artist)
                 parts.push(`Featured Artists: ${t.artists}`);
  if (t.album)   parts.push(`Album: ${t.album}`);
  if (t.album_artist && t.album_artist !== t.artist)
                 parts.push(`Album Artist: ${t.album_artist}`);

  // ── Temporal context ──
  if (t.year) {
    if (t.original_year && t.original_year !== t.year) {
      parts.push(`Year: originally recorded ${t.original_year}, released ${t.year}`);
    } else {
      parts.push(`Year: ${t.year}`);
    }
  }

  // ── Genre & mood (from tags) ──
  if (t.genre)  parts.push(`Genre: ${t.genre}`);
  if (t.mood)   parts.push(`Mood tags: ${t.mood}`);

  // ── Credits ──
  if (t.composer)  parts.push(`Composer: ${t.composer}`);
  if (t.lyricist)  parts.push(`Lyricist: ${t.lyricist}`);
  if (t.producer)  parts.push(`Producer: ${t.producer}`);
  if (t.engineer)  parts.push(`Engineer: ${t.engineer}`);
  if (t.mixer)     parts.push(`Mixer: ${t.mixer}`);
  if (t.remixer)   parts.push(`Remixer: ${t.remixer}`);

  // ── Release context ──
  if (t.label)           parts.push(`Label: ${t.label}`);
  if (t.release_country) parts.push(`Release country: ${t.release_country}`);
  if (t.language)        parts.push(`Language: ${t.language}`);
  if (t.media)           parts.push(`Media: ${t.media}`);
  if (t.duration)        parts.push(`Duration: ${Math.round(t.duration)}s`);
  if (t.comment)         parts.push(`Comment: ${t.comment}`);

  // ── Acoustic features ──
  const bpm = t.bpm_essentia ?? t.bpm;
  if (bpm)                   parts.push(`Tempo: ${describeTempo(bpm)}`);

  const key = t.key_essentia ?? t.key;
  if (key)                   parts.push(`Key: ${describeKey(key, t.key_strength)}`);

  if (t.energy !== null)           parts.push(`Energy: ${describeEnergy(t.energy)}`);
  if (t.valence !== null)          parts.push(`Valence: ${describeValence(t.valence)}`);
  if (t.danceability !== null)     parts.push(`Danceability: ${describeDanceability(t.danceability)}`);
  if (t.acousticness !== null)     parts.push(`Acousticness: ${describeAcousticness(t.acousticness)}`);
  if (t.instrumentalness !== null) parts.push(`Instrumentalness: ${describeInstrumentalness(t.instrumentalness)}`);
  if (t.speechiness !== null)      parts.push(`Speechiness: ${describeSpeechiness(t.speechiness)}`);
  if (t.loudness !== null)         parts.push(`Loudness: ${describeLoudness(t.loudness)}`);

  // ── Spectral character ──
  if (t.spectral_centroid !== null) parts.push(`Brightness: ${describeBrightness(t.spectral_centroid)}`);
  if (t.spectral_flux !== null)     parts.push(`Texture dynamism: ${describeDynamism(t.spectral_flux)}`);
  if (t.zero_crossing_rate !== null) parts.push(`Grit/distortion: ${describeGrit(t.zero_crossing_rate)}`);

  // ── Synthesized holistic descriptions ──
  const emotionalArc = synthesizeEmotionalArc(t);
  if (emotionalArc) parts.push(emotionalArc);

  const soundProfile = synthesizeSoundProfile(t);
  if (soundProfile) parts.push(soundProfile);

  // ── Lyrics ──
  if (t.lyrics_summary) parts.push(`Lyrical summary: ${t.lyrics_summary}`);
  if (t.lyrics_raw)     parts.push(`Lyrics excerpt: ${t.lyrics_raw}`);
  return parts.join('. ');
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function retextLibrary(db: Database.Database): Promise<void> {
  const spinner = ora('Rebuilding metadata text with full acoustic + lyrical features...').start();

  const tracks = db.prepare(`
    SELECT id, title, artist, artists, album, album_artist, year, genre, mood,
           bpm, key, duration, composer, lyricist, producer, engineer, mixer,
           remixer, label, media, release_country, comment, language,
           bpm_essentia, key_essentia, key_strength, energy, valence, danceability,
           acousticness, instrumentalness, speechiness, loudness,
           spectral_centroid, spectral_flux, zero_crossing_rate,
           lyrics_summary, lyrics_raw
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
  console.log(chalk.cyan(`   Run 'npm run embed' to re-embed with all features`));
}