# Rendering Benchmark Results

Approaches:
- **gif-js** — current JS pipeline: xterm.js → our renderer → gifenc
- **gif-agg** — shell out to `agg` (Rust, purpose-built for .cast → GIF)
- **mp4-js** — current JS pipeline: xterm.js → our renderer → giant temp RGBA file → ffmpeg
- **mp4-stream** — streaming JS pipeline: xterm.js → our renderer → pipe to ffmpeg stdin (no temp file)
- **mp4-agg** — agg → gif → ffmpeg mp4 (two hops, 256-color limit)

Install `agg` to run gif-agg and mp4-agg:
```sh
cargo install agg
# or
brew install agg  # if available
```

## demo-session.cast — 2026-03-29

| Approach | Avg | Min | Max | Peak mem | Output size | Notes |
|---|---|---|---|---|---|---|
| gif-js | 13.3s | 13.2s | 13.4s | +4061MB | 19608KB | |
| mp4-js | 11.4s | 11.4s | 11.5s | +0MB | 14586KB | |
| mp4-stream | — | — | — | — | — | SKIP: proc.stdin.getWriter is not a function. (In 'proc.stdin.getWriter()', 'proc.stdin.getWriter' is undefined) |

## demo-session.cast — 2026-03-29

| Approach | Avg | Min | Max | Peak mem | Output size | Notes |
|---|---|---|---|---|---|---|
| gif-agg | — | — | — | — | — | SKIP: agg not installed (brew install agg / cargo install agg) |
| mp4-stream | — | — | — | — | — | SKIP: ffmpeg failed: ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers
  built with Apple clang version 17.0.0 (clang-1700.6.4.2)
  configuration: --prefix=/Users/dayvidwang/.local/share/mise/installs/ffmpeg/8.1
  libavutil      60. 26.100 / 60. 26.100
  libavcodec     62. 28.100 / 62. 28.100
  libavformat    62. 12.100 / 62. 12.100
  libavdevice    62.  3.100 / 62.  3.100
  libavfilter    11. 14.100 / 11. 14.100
  libswscale      9.  5.100 /  9.  5.100
  libswresample   6.  3.100 /  6.  3.100
Unrecognized option 'crf'.
Error splitting the argument list: Option not found
 |
| mp4-agg | — | — | — | — | — | SKIP: agg not installed |

## demo-session.cast — 2026-03-29

| Approach | Avg | Min | Max | Peak mem | Output size | Notes |
|---|---|---|---|---|---|---|
| gif-agg | 44.6s | 44.6s | 44.6s | +1MB | 1226KB | |
| mp4-stream | 8.6s | 8.4s | 8.8s | +1895MB | 14586KB | |
| mp4-agg | — | — | — | — | — | SKIP: ffmpeg failed: ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers
  built with Apple clang version 17.0.0 (clang-1700.6.4.2)
  configuration: --prefix=/Users/dayvidwang/.local/share/mise/installs/ffmpeg/8.1
  libavutil      60. 26.100 / 60. 26.100
  libavcodec     62. 28.100 / 62. 28.100
  libavformat    62. 12.100 / 62. 12.100
  libavdevice    62.  3.100 / 62.  3.100
  libavfilter    11. 14.100 / 11. 14.100
  libswscale      9.  5.100 /  9.  5.100
  libswresample   6.  3.100 /  6.  3.100
Input #0, gif, from '/var/folders/lh/dx2xn7p95394vvcrjckbkp5h0000gp/T/pty-mcp-bench-1774781392125-q0uor6yf3pq.gif':
  Metadata:
    comment         : gif.ski
  Duration: 00:00:41.01, start: 0.000000, bitrate: 244 kb/s
  Stream #0:0: Video: gif, bgra, 1171x918, 5.56 fps, 100 tbr, 100 tbn
[vost#0:0 @ 0x127007500] Unknown encoder 'libx264'
[vost#0:0 @ 0x127007500] Error selecting an encoder
Error opening output file /var/folders/lh/dx2xn7p95394vvcrjckbkp5h0000gp/T/pty-mcp-bench-1774781392125-7x7n7tewhgu.mp4.
Error opening output files: Encoder not found
 |

## demo-session.cast — 2026-03-29

| Approach | Avg | Min | Max | Peak mem | Output size | Notes |
|---|---|---|---|---|---|---|
| mp4-agg | 45.4s | 44.9s | 46.0s | +1MB | 3977KB | |

## demo-session.cast — 2026-03-29

| Approach | Avg | Min | Max | Peak mem | Output size | Notes |
|---|---|---|---|---|---|---|
| gif-agg | 45.9s | 45.9s | 46.0s | +1MB | 1226KB | |
| mp4-stream | 8.7s | 8.5s | 8.9s | +1676MB | 14586KB | |

## demo-session.cast — 2026-03-29

| Approach | Avg | Min | Max | Peak mem | Output size | Notes |
|---|---|---|---|---|---|---|
| mp4-stream | 8.1s | 8.0s | 8.1s | +5MB | 10499KB | |
