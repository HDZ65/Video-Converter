# Video Converter

Simple web tool that converts videos to MP4 H.264 Main@4.1 + AAC 128k 48k stereo with faststart.

## Requirements

- Node.js 18+
- ffmpeg and ffprobe installed and available in PATH

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000` and upload a video.

## LAN access

The server listens on `0.0.0.0` by default, so other devices on the same network can access it.
Use your LAN IP, for example: `http://<your-lan-ip>:3000`.

## HLS / DASH outputs

After conversion completes, the streaming manifests are available at:

- HLS: `http://localhost:3000/api/hls/<jobId>/index.m3u8`
- DASH: `http://localhost:3000/api/dash/<jobId>/stream.mpd`

Segments are served from the same base path.

## Notes

- Converted files are stored temporarily and cleaned up after 1 hour.
- Max upload size is 5 GB (server-side limit).

# Video-Converter
# Video-Converter
# Video-Converter
