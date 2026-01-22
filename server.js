const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";

const storageRoot = path.join(os.tmpdir(), "video-converter");
const uploadsDir = path.join(storageRoot, "uploads");
const outputsDir = path.join(storageRoot, "outputs");

for (const dir of [storageRoot, uploadsDir, outputsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024
  }
});

const jobs = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/convert", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing file" });
  }

  const jobId = randomUUID();
  const inputPath = req.file.path;
  const jobDir = path.join(outputsDir, jobId);
  const outputPath = path.join(jobDir, "output.mp4");
  const hlsDir = path.join(jobDir, "hls");
  const dashDir = path.join(jobDir, "dash");

  fs.mkdirSync(jobDir, { recursive: true });

  const job = {
    id: jobId,
    status: "queued",
    progress: 0,
    duration: null,
    inputPath,
    jobDir,
    outputPath,
    hlsDir,
    dashDir,
    error: null,
    createdAt: Date.now()
  };

  jobs.set(jobId, job);
  res.json({ jobId });

  runConversion(jobId).catch((error) => {
    const current = jobs.get(jobId);
    if (current) {
      current.status = "error";
      current.error = error.message;
    }
  });
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error
  });
});

app.get("/api/progress/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).end();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const sendUpdate = () => {
    const current = jobs.get(req.params.id);
    if (!current) {
      res.write("event: error\ndata: Job not found\n\n");
      return;
    }

    res.write(`event: progress\ndata: ${JSON.stringify({
      status: current.status,
      progress: current.progress,
      error: current.error
    })}\n\n`);

    if (current.status === "done") {
      res.write(`event: done\ndata: ${JSON.stringify({
        downloadUrl: `/api/download/${current.id}`,
        hlsUrl: `/api/hls/${current.id}/index.m3u8`,
        dashUrl: `/api/dash/${current.id}/stream.mpd`
      })}\n\n`);
      clearInterval(interval);
      res.end();
    }

    if (current.status === "error") {
      clearInterval(interval);
      res.end();
    }
  };

  const interval = setInterval(sendUpdate, 1000);
  sendUpdate();

  req.on("close", () => {
    clearInterval(interval);
  });
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "Not ready" });
  }

  res.download(job.outputPath, `${job.id}.mp4`);
});

app.get("/api/hls/:id/:file?", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "Not ready" });
  }

  const fileName = req.params.file || "index.m3u8";
  const safeName = path.basename(fileName);
  const filePath = path.join(job.hlsDir, safeName);
  res.sendFile(filePath, (err) => {
    if (err) {
      res.status(404).json({ error: "Not found" });
    }
  });
});

app.get("/api/dash/:id/:file?", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "Not ready" });
  }

  const fileName = req.params.file || "stream.mpd";
  const safeName = path.basename(fileName);
  const filePath = path.join(job.dashDir, safeName);
  res.sendFile(filePath, (err) => {
    if (err) {
      res.status(404).json({ error: "Not found" });
    }
  });
});

app.listen(port, host, () => {
  console.log(`Video converter running on http://${host}:${port}`);
});

async function runConversion(jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  job.status = "probing";
  job.duration = await probeDuration(job.inputPath);
  job.status = "converting";

  await runFfmpeg(
    [
      "-y",
      "-i",
      job.inputPath,
      "-c:v",
      "libx264",
      "-profile:v",
      "main",
      "-level",
      "4.1",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "medium",
      "-crf",
      "22",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      job.outputPath
    ],
    (data) => {
      const text = data.toString();
      const match = /time=([0-9:.]+)/.exec(text);
      if (!match) {
        return;
      }

      const seconds = parseTimestamp(match[1]);
      if (job.duration && seconds !== null) {
        const ratio = Math.min(seconds / job.duration, 0.99);
        job.progress = Math.max(job.progress, Math.round(ratio * 100));
      }
    }
  );

  job.status = "packaging-hls";
  await generateHls(job);
  job.status = "packaging-dash";
  await generateDash(job);

  job.status = "done";
  job.progress = 100;
  scheduleCleanup(jobId);
}

function runFfmpeg(args, onStderr) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);
    if (onStderr) {
      ffmpeg.stderr.on("data", onStderr);
    }
    ffmpeg.on("error", (error) => reject(error));
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with ${code}`));
      }
    });
  });
}

async function generateHls(job) {
  fs.mkdirSync(job.hlsDir, { recursive: true });
  const args = [
    "-y",
    "-i",
    job.outputPath,
    "-codec",
    "copy",
    "-start_number",
    "0",
    "-hls_time",
    "6",
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    path.join(job.hlsDir, "segment_%03d.ts"),
    path.join(job.hlsDir, "index.m3u8")
  ];

  await runFfmpeg(args);
}

async function generateDash(job) {
  fs.mkdirSync(job.dashDir, { recursive: true });
  const args = [
    "-y",
    "-i",
    job.outputPath,
    "-codec",
    "copy",
    "-seg_duration",
    "6",
    "-use_timeline",
    "1",
    "-use_template",
    "1",
    "-f",
    "dash",
    path.join(job.dashDir, "stream.mpd")
  ];

  await runFfmpeg(args);
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ];

    const ffprobe = spawn("ffprobe", args);
    let output = "";

    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("close", () => {
      const value = parseFloat(output.trim());
      if (Number.isFinite(value)) {
        resolve(value);
      } else {
        resolve(null);
      }
    });

    ffprobe.on("error", () => resolve(null));
  });
}

function parseTimestamp(value) {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return null;
  }

  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function scheduleCleanup(jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  setTimeout(() => {
    const current = jobs.get(jobId);
    if (!current) {
      return;
    }

    fs.unlink(current.inputPath, () => {});
    if (current.jobDir) {
      fs.rm(current.jobDir, { recursive: true, force: true }, () => {});
    } else {
      fs.unlink(current.outputPath, () => {});
    }

    jobs.delete(jobId);
  }, 60 * 60 * 1000);
}
