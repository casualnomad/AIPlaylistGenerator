#!/usr/bin/env python3
"""
analyze.py — Acoustic feature extraction using Essentia
Reads unanalyzed tracks from the SQLite DB, runs Essentia analysis,
and writes features back to the DB.

Usage:
    python3 analyze.py              # analyze all unanalyzed tracks
    python3 analyze.py --all        # re-analyze everything (overwrite)
    python3 analyze.py --limit 100  # analyze only N tracks
"""

from email.mime import audio
import sys
import argparse
import sqlite3
import os
import time

try:
    import essentia.standard as es
    import numpy as np
except ImportError:
    print("❌ Essentia not installed. Run: pip3 install essentia")
    sys.exit(1)

# Path to the SQLite database
DB_PATH = os.path.join(os.path.dirname(__file__), "data", "library.db")


def analyze_file(file_path: str) -> dict | None:
    """
    Run Essentia analysis on an audio file.
    Returns a dict of acoustic features, or None on failure.
    """
    try:
        # Load audio as mono, 44100Hz
        loader = es.MonoLoader(filename=file_path, sampleRate=44100)
        audio = loader()

        stereo_loader = es.AudioLoader(filename=file_path)
        stereo_audio, sample_rate, num_channels, _, _, _ = stereo_loader()

        if len(audio) == 0:
            return None

        # --- Rhythm ---
        rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
        bpm, beats, beats_confidence, _, beats_intervals = rhythm_extractor(audio)

        # Danceability (0-3, we normalize to 0-1)
        danceability_extractor = es.Danceability()
        danceability, _ = danceability_extractor(audio)
        danceability = float(danceability) / 3.0

        # --- Loudness & Energy ---
        if num_channels == 2:
            loudness_extractor = es.LoudnessEBUR128(sampleRate=int(sample_rate))
            _, _, integrated, _ = loudness_extractor(stereo_audio)
            loudness = float(integrated)
        else:
            loudness = float(np.log10(es.Loudness()(audio) + 1e-9) * 20)        
        
        rms = float(es.RMS()(audio))
        energy = min(1.0, rms * 10)

        # --- Tonal ---
        # Key detection
        tonal_extractor = es.TonalExtractor()
        tonal = tonal_extractor(audio)
        key_key = es.Key()
        windowed_audio = es.FrameGenerator(audio, frameSize=4096, hopSize=2048)
        hpcp_list = []
        for frame in windowed_audio:
            frame_w = es.Windowing(type='blackmanharris92')(frame)
            spec = es.Spectrum()(frame_w)
            freq, mag = es.SpectralPeaks()(spec)
            hpcp = es.HPCP()(freq, mag)
            hpcp_list.append(hpcp)
        avg_hpcp = np.mean(hpcp_list, axis=0)
        key, scale, key_strength, _ = es.Key()(avg_hpcp)
        key_strength = float(key_strength)

        # Tuning frequency (deviation from 440Hz — useful for old recordings)
        tuning_freq = 440.0  # default, skip analysis
        # --- Spectral features (brightness, warmth, texture) ---
        # Run frame-by-frame spectral analysis
        frame_size = 2048
        hop_size = 1024
        window = es.Windowing(type="hann")
        spectrum = es.Spectrum()
        centroid = es.SpectralCentroidTime()
        rolloff = es.RollOff()
        flux = es.Flux()
        zcr = es.ZeroCrossingRate()

        centroids = []
        rolloffs = []
        fluxes = []
        zcrs = []

        for frame in es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size):
            windowed = window(frame)
            spec = spectrum(windowed)
            centroids.append(float(centroid(frame)))
            rolloffs.append(float(rolloff(spec)))
            fluxes.append(float(flux(spec)))
            zcrs.append(float(zcr(frame)))

        spectral_centroid = float(np.mean(centroids))   # brightness
        spectral_rolloff  = float(np.mean(rolloffs))    # high freq content
        spectral_flux     = float(np.mean(fluxes))      # how much spectrum changes
        zero_crossing_rate = float(np.mean(zcrs))       # noisiness / acousticness proxy

        # --- Derived perceptual estimates ---
        # Acousticness: low ZCR + low centroid = more acoustic
        acousticness = max(0.0, min(1.0, 1.0 - (zero_crossing_rate * 5 + spectral_centroid / 8000)))

        # Speechiness: high ZCR + mid centroid = more speech-like
        speechiness = max(0.0, min(1.0, zero_crossing_rate * 3))

        # Instrumentalness: inverse of speechiness (rough proxy)
        instrumentalness = max(0.0, min(1.0, 1.0 - speechiness * 1.5))

        # Valence: major key = more positive; minor = less
        # Combine with energy and brightness for a rough valence estimate
        key_valence = 0.6 if scale == "major" else 0.4
        valence = max(0.0, min(1.0, key_valence * 0.5 + energy * 0.3 + (spectral_centroid / 20000) * 0.2))

        return {
            "bpm_essentia":       round(float(bpm), 2),
            "key_essentia":       f"{key} {scale}",
            "key_strength":       round(key_strength, 4),
            "tuning_freq":        None,
            "energy":             round(energy, 4),
            "loudness":           round(loudness, 4),
            "danceability":       round(danceability, 4),
            "acousticness":       round(acousticness, 4),
            "speechiness":        round(speechiness, 4),
            "instrumentalness":   round(instrumentalness, 4),
            "valence":            round(valence, 4),
            "spectral_centroid":  round(spectral_centroid, 4),
            "spectral_rolloff":   round(spectral_rolloff, 4),
            "spectral_flux":      round(spectral_flux, 4),
            "zero_crossing_rate": round(zero_crossing_rate, 6),
        }

    except Exception as e:
        print(f"\n  ❌ {os.path.basename(file_path)}: {e}")
        return None

def format_bar(done: int, total: int, width: int = 30) -> str:
    filled = int(width * done / total)
    return f"[{'█' * filled}{'░' * (width - filled)}]"


def main():
    parser = argparse.ArgumentParser(description="Acoustic feature extraction with Essentia")
    parser.add_argument("--all",   action="store_true", help="Re-analyze all tracks (overwrite existing)")
    parser.add_argument("--limit", type=int, default=None, help="Only analyze N tracks")
    args = parser.parse_args()

    if not os.path.exists(DB_PATH):
        print(f"❌ Database not found at {DB_PATH}")
        print("   Run 'npm run scan' first.")
        sys.exit(1)

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    # Fetch tracks to analyze
    if args.all:
        query = "SELECT id, file_path FROM tracks ORDER BY id"
    else:
        query = "SELECT id, file_path FROM tracks WHERE analyzed = 0 OR analyzed IS NULL ORDER BY id"

    if args.limit:
        query += f" LIMIT {args.limit}"

    tracks = db.execute(query).fetchall()
    total = len(tracks)

    if total == 0:
        print("✅ All tracks already analyzed! Use --all to re-analyze.")
        db.close()
        return

    print(f"\n🎵 Analyzing {total} tracks with Essentia...\n")
    print("   This decodes actual audio — slower than metadata scanning.")
    print("   Grab a bigger coffee ☕☕\n")

    update = db.prepare if hasattr(db, 'prepare') else None  # sqlite3 uses execute directly

    done = 0
    errors = 0
    start_time = time.time()

    for track in tracks:
        track_id = track["id"]
        file_path = track["file_path"]

        features = analyze_file(file_path)

        if features:
            db.execute("""
                UPDATE tracks SET
                    analyzed          = 1,
                    bpm_essentia      = :bpm_essentia,
                    key_essentia      = :key_essentia,
                    key_strength      = :key_strength,
                    tuning_freq       = :tuning_freq,
                    energy            = :energy,
                    loudness          = :loudness,
                    danceability      = :danceability,
                    acousticness      = :acousticness,
                    speechiness       = :speechiness,
                    instrumentalness  = :instrumentalness,
                    valence           = :valence,
                    spectral_centroid = :spectral_centroid,
                    spectral_rolloff  = :spectral_rolloff,
                    spectral_flux     = :spectral_flux,
                    zero_crossing_rate = :zero_crossing_rate
                WHERE id = :id
            """, {**features, "id": track_id})
            done += 1
        else:
            db.execute("UPDATE tracks SET analyzed = -1 WHERE id = :id", {"id": track_id})
            errors += 1

        # Commit every 10 tracks
        if (done + errors) % 10 == 0:
            db.commit()

        # Progress display
        elapsed = time.time() - start_time
        rate = (done + errors) / elapsed if elapsed > 0 else 0
        remaining = (total - done - errors) / rate if rate > 0 else 0
        bar = format_bar(done + errors, total)

        print(
            f"\r  {bar} {done + errors}/{total} "
            f"— {rate:.1f}/s "
            f"— ~{int(remaining)}s remaining "
            f"{'❌ ' + str(errors) + ' errors' if errors else ''}",
            end="",
            flush=True
        )

    db.commit()
    db.close()

    elapsed = time.time() - start_time
    print(f"\n\n✅ Analyzed {done} tracks in {int(elapsed)}s"
          + (f" ({errors} failed)" if errors else ""))
    print("\nRun 'npm run embed' to re-embed with the new acoustic features!")


if __name__ == "__main__":
    main()
