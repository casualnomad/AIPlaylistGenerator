import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/library.db');

export function getDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  
  // Load sqlite-vec extension for vector similarity search
  sqliteVec.load(db);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  return db;
}

export function initDb(db: Database.Database): void {
  // Main tracks table
  db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT UNIQUE NOT NULL,
    title           TEXT,
    artist          TEXT,
    artists         TEXT,
    album           TEXT,
    album_artist    TEXT,
    track_no        INTEGER,
    disk_no         INTEGER,
    year            INTEGER,
    duration        REAL,
    genre           TEXT,
    mood            TEXT,
    bpm             REAL,
    key             TEXT,
    composer        TEXT,
    lyricist        TEXT,
    producer        TEXT,
    engineer        TEXT,
    mixer           TEXT,
    remixer         TEXT,
    performer       TEXT,
    label           TEXT,
    catalog_no      TEXT,
    isrc            TEXT,
    media           TEXT,
    release_country TEXT,
    comment         TEXT,
    language        TEXT,
    mb_track_id     TEXT,
    mb_artist_id    TEXT,
    mb_album_id     TEXT,
    metadata_text   TEXT,
    embedded        INTEGER DEFAULT 0,
    scanned_at      INTEGER DEFAULT (unixepoch()),
    embedded_at     INTEGER,
    analyzed        INTEGER DEFAULT 0,
    energy          REAL,
    valence         REAL,
    danceability    REAL,
    acousticness    REAL,
    instrumentalness REAL,
    speechiness     REAL,
    loudness        REAL,
     bpm_essentia      REAL,
    key_essentia      TEXT,
    key_strength      REAL,
    tuning_freq       REAL,
    spectral_centroid REAL,
    spectral_rolloff  REAL,
    spectral_flux     REAL,
    zero_crossing_rate REAL,
    lyrics_raw      TEXT,
    lyrics_summary  TEXT,
    lyrics_fetched  INTEGER DEFAULT 0
  );
`);

  // Virtual table for vector search (768 dims for nomic-embed-text)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS track_embeddings USING vec0(
      track_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    );
  `);

  // Playlists table to store generated playlists
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      prompt      TEXT,
      type        TEXT CHECK(type IN ('vibe', 'cluster')),
      created_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
      track_id    INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      reason      TEXT,
      PRIMARY KEY (playlist_id, track_id)
    );
  `);

  console.log('✅ Database initialised');
}
