#!/usr/bin/env python3
"""
analyze.py — Parallel acoustic feature extraction using Essentia
Uses all available CPU cores via multiprocessing for maximum throughput.

Usage:
    python3 analyze.py              # analyze all unanalyzed tracks
    python3 analyze.py --all        # re-analyze everything (overwrite)
    python3 analyze.py --limit 100  # analyze only N tracks
    python3 analyze.py --workers 4  # manually set worker count
    python3 analyze.py --verbose    # show errors inline
"""

import sys
import argparse
import sqlite3
import os
import time
import multiprocessing as mp
from multiprocessing import Pool, Queue, Manager
import queue

# Suppress Essentia INFO spam before importing
os.environ["GLOG_minloglevel"] = "3"

DB_PATH     = os.path.join(os.path.dirname(__file__), "data", "library.db")
SAMPLE_RATE = 22050
FRAME_SIZE  = 2048
HOP_SIZE    = 1024


def analyze_file(file_path: str) -> dict:
    """
    Run lean Essentia analysis on a single file.
    This function runs in a worker process — imports are intentionally inside
    the function so each worker gets its own Essentia instance.
    """
    import essentia
    essentia.log.infoActive    = False
    essentia.log.warningActive = False
    import essentia.standard as es
    import numpy as np

    audio = es.MonoLoader(filename=file_path, sampleRate=SAMPLE_RATE)()

    if len(audio) < SAMPLE_RATE:
        raise ValueError("Audio too short")

    # BPM
    bpm, _, _, _, _ = es.RhythmExtractor2013(method="degara")(audio)

    # Loudness & energy
    stereo = np.column_stack([audio, audio]).astype(np.float32)  # LoudnessEBUR128 expects stereo input
    _, _, loudness, _ = es.LoudnessEBUR128(sampleRate=SAMPLE_RATE)(stereo)
    loudness = float(loudness)
    #energy   = min(1.0, float(es.RMS()(audio)) * 10)

    rms = float(es.RMS()(audio))
    # Normalize RMS to 0-1 using a log scale — matches human loudness perception
    # RMS typically ranges 0.01–0.3 for music; log scale spreads it out properly
    import math
    energy = max(0.0, min(1.0, (math.log10(max(rms, 1e-6)) + 2) / 2.5))

    # Danceability
    danceability, _ = es.Danceability()(audio)
    danceability    = min(1.0, float(danceability) / 3.0)

    # Key via HPCP (sampled frames)
    windowing  = es.Windowing(type="blackmanharris92")
    spectrum   = es.Spectrum()
    peaks      = es.SpectralPeaks()
    hpcp_algo  = es.HPCP()
    key_algo   = es.Key()

    hpcps  = []
    frames = list(es.FrameGenerator(audio, frameSize=FRAME_SIZE, hopSize=HOP_SIZE * 4))
    for frame in frames:
        spec       = spectrum(windowing(frame))
        freq, mag  = peaks(spec)
        hpcps.append(hpcp_algo(freq, mag))

    avg_hpcp              = np.mean(hpcps, axis=0) if hpcps else np.zeros(12)
    key, scale, key_strength, _ = key_algo(avg_hpcp.astype(np.float32))

    # Spectral features (sampled frames)
    centroid_algo = es.SpectralCentroidTime()
    zcr_algo      = es.ZeroCrossingRate()
    rolloff_algo  = es.RollOff()
    flux_algo     = es.Flux()

    centroids, zcrs, rolloffs, fluxes = [], [], [], []
    for frame in frames:
        spec = spectrum(windowing(frame))
        centroids.append(float(centroid_algo(frame)))
        zcrs.append(float(zcr_algo(frame)))
        rolloffs.append(float(rolloff_algo(spec)))
        fluxes.append(float(flux_algo(spec)))

    spectral_centroid  = float(np.mean(centroids))
    zero_crossing_rate = float(np.mean(zcrs))
    spectral_rolloff   = float(np.mean(rolloffs))
    spectral_flux      = float(np.mean(fluxes))

    # Derived perceptual features
    acousticness     = max(0.0, min(1.0, 1.0 - (zero_crossing_rate * 5 + spectral_centroid / 8000)))
    speechiness      = max(0.0, min(1.0, zero_crossing_rate * 3))
    instrumentalness = max(0.0, min(1.0, 1.0 - speechiness * 1.5))
    key_valence      = 0.6 if scale == "major" else 0.4
    valence          = max(0.0, min(1.0, key_valence * 0.5 + energy * 0.3 + (spectral_centroid / 20000) * 0.2))

    return {
        "bpm_essentia":        round(float(bpm), 2),
        "key_essentia":        f"{key} {scale}",
        "key_strength":        round(float(key_strength), 4),
        "tuning_freq":         None,
        "energy":              round(energy, 4),
        "loudness":            round(loudness, 4),
        "danceability":        round(danceability, 4),
        "acousticness":        round(acousticness, 4),
        "speechiness":         round(speechiness, 4),
        "instrumentalness":    round(instrumentalness, 4),
        "valence":             round(valence, 4),
        "spectral_centroid":   round(spectral_centroid, 4),
        "spectral_rolloff":    round(spectral_rolloff, 4),
        "spectral_flux":       round(spectral_flux, 4),
        "zero_crossing_rate":  round(zero_crossing_rate, 6),
    }


def worker_fn(args):
    """Top-level worker function for multiprocessing (must be picklable)."""
    import signal

    def timeout_handler(signum, frame):
        raise TimeoutError("Analysis timed out")

    track_id, file_path = args
    try:
        # Kill any track that takes more than 60 seconds
        signal.signal(signal.SIGALRM, timeout_handler)
        signal.alarm(60)
        features = analyze_file(file_path)
        signal.alarm(0)  # cancel alarm on success
        return (track_id, file_path, features, None)
    except Exception as e:
        signal.alarm(0)
        return (track_id, file_path, None, str(e))


def format_bar(done: int, total: int, width: int = 30) -> str:
    filled = int(width * done / total)
    return f"[{'█' * filled}{'░' * (width - filled)}]"


def main():
    parser = argparse.ArgumentParser(description="Parallel acoustic feature extraction")
    parser.add_argument("--all",     action="store_true", help="Re-analyze all tracks")
    parser.add_argument("--limit",   type=int,   default=None, help="Only analyze N tracks")
    parser.add_argument("--workers", type=int,   default=None, help="Number of worker processes (default: all cores)")
    parser.add_argument("--verbose", action="store_true",      help="Print errors inline")
    args = parser.parse_args()

    num_workers = args.workers or mp.cpu_count()

    if not os.path.exists(DB_PATH):
        print(f"❌ Database not found at {DB_PATH}")
        print("   Run 'npm run scan' first.")
        sys.exit(1)

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    if args.all:
        query = "SELECT id, file_path FROM tracks ORDER BY id"
    else:
        query = "SELECT id, file_path FROM tracks WHERE analyzed = 0 OR analyzed IS NULL ORDER BY id"

    if args.limit:
        query += f" LIMIT {args.limit}"

    tracks = db.execute(query).fetchall()
    total  = len(tracks)

    if total == 0:
        print("✅ All tracks already analyzed! Use --all to re-analyze.")
        db.close()
        return

    print(f"\n🎵 Analyzing {total} tracks across {num_workers} workers...\n")

    work_items = [(row["id"], row["file_path"]) for row in tracks]

    done   = 0
    errors = 0
    start  = time.time()

    # Use imap_unordered so results stream back as soon as each track finishes
    with Pool(processes=num_workers) as pool:
        try:
          for track_id, file_path, features, error in pool.imap(worker_fn, work_items, chunksize=1):
            if features:
                db.execute("""
                    UPDATE tracks SET
                        analyzed           = 1,
                        bpm_essentia       = :bpm_essentia,
                        key_essentia       = :key_essentia,
                        key_strength       = :key_strength,
                        tuning_freq        = :tuning_freq,
                        energy             = :energy,
                        loudness           = :loudness,
                        danceability       = :danceability,
                        acousticness       = :acousticness,
                        speechiness        = :speechiness,
                        instrumentalness   = :instrumentalness,
                        valence            = :valence,
                        spectral_centroid  = :spectral_centroid,
                        spectral_rolloff   = :spectral_rolloff,
                        spectral_flux      = :spectral_flux,
                        zero_crossing_rate = :zero_crossing_rate
                    WHERE id = :id
                """, {**features, "id": track_id})
                done += 1
            else:
                if args.verbose:
                    print(f"\n  ❌ {os.path.basename(file_path)}: {error}")
                db.execute("UPDATE tracks SET analyzed = -1 WHERE id = :id", {"id": track_id})
                errors += 1

            # Commit every 20 tracks
            if (done + errors) % 20 == 0:
                db.commit()

            # Progress display
            elapsed   = time.time() - start
            rate      = (done + errors) / elapsed if elapsed > 0 else 0
            remaining = (total - done - errors) / rate if rate > 0 else 0
            bar       = format_bar(done + errors, total)

            print(
                f"\r  {bar} {done + errors}/{total} "
                f"— {rate:.1f}/s "
                f"— ~{int(remaining)}s remaining"
                + (f" ❌ {errors} errors" if errors else ""),
                end="", flush=True
            )
        except Exception as e:
            print(f"\n⚠️ Pool error: {e}")

    db.commit()
    db.close()

    elapsed = time.time() - start
    print(f"\n\n✅ Analyzed {done} tracks in {int(elapsed)}s"
          + (f" ({errors} failed)" if errors else ""))
    print("\nRun 'npm run lyrics && npm run retext && npm run embed' to update embeddings!")



if __name__ == "__main__":
    main()