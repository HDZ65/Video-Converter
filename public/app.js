const fileInput = document.getElementById("file-input");
const dropZone = document.getElementById("drop-zone");
const convertButton = document.getElementById("convert-button");
const statusText = document.getElementById("status");
const progressBar = document.getElementById("progress");
const downloadLink = document.getElementById("download-link");
const hlsLink = document.getElementById("hls-link");
const dashLink = document.getElementById("dash-link");
const hlsCopyButton = document.getElementById("copy-hls");
const dashCopyButton = document.getElementById("copy-dash");
const mp4CopyButton = document.getElementById("copy-mp4");

let currentFile = null;
let pollTimer = null;
let eventSource = null;

function setStatus(text) {
  statusText.textContent = text;
}

function setProgress(value) {
  const clamped = Math.min(100, Math.max(0, value));
  progressBar.value = clamped;
}

function setBusy(isBusy) {
  fileInput.disabled = isBusy;
  convertButton.disabled = isBusy;
  document.body.classList.toggle("is-busy", isBusy);
}

function resetDownload() {
  downloadLink.hidden = true;
  downloadLink.href = "#";
  hlsLink.hidden = true;
  hlsLink.href = "#";
  dashLink.hidden = true;
  dashLink.href = "#";
  hlsCopyButton.hidden = true;
  dashCopyButton.hidden = true;
  mp4CopyButton.hidden = true;
}

function clearTimers() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function handleFiles(files) {
  if (!files || files.length === 0) {
    return;
  }

  currentFile = files[0];
  dropZone.classList.add("has-file");
  setStatus(`Selected: ${currentFile.name}`);
  resetDownload();
  setProgress(0);
}

fileInput.addEventListener("change", (event) => {
  handleFiles(event.target.files);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragover");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragover");
  handleFiles(event.dataTransfer.files);
});

convertButton.addEventListener("click", async () => {
  if (!currentFile) {
    setStatus("Select a file first.");
    return;
  }

  setBusy(true);
  resetDownload();
  setProgress(0);
  setStatus("Uploading...");
  clearTimers();

  try {
    const formData = new FormData();
    formData.append("file", currentFile);

    const response = await fetch("/api/convert", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      throw new Error("Upload failed");
    }

    const payload = await response.json();
    if (!payload.jobId) {
      throw new Error("Missing job id");
    }

    setStatus("Converting...");
    listenProgress(payload.jobId);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    setBusy(false);
  }
});

function listenProgress(jobId) {
  try {
    eventSource = new EventSource(`/api/progress/${jobId}`);
    eventSource.addEventListener("progress", (event) => {
      const data = JSON.parse(event.data);
      if (typeof data.progress === "number") {
        setProgress(data.progress);
      }
      if (data.status) {
        setStatus(`Status: ${data.status}`);
      }
    });

    eventSource.addEventListener("done", (event) => {
      const data = JSON.parse(event.data);
      if (data.downloadUrl) {
        downloadLink.href = data.downloadUrl;
        downloadLink.hidden = false;
        mp4CopyButton.hidden = false;
      }
      if (data.hlsUrl) {
        hlsLink.href = data.hlsUrl;
        hlsLink.hidden = false;
        hlsCopyButton.hidden = false;
      }
      if (data.dashUrl) {
        dashLink.href = data.dashUrl;
        dashLink.hidden = false;
        dashCopyButton.hidden = false;
      }
      setStatus("Done");
      setProgress(100);
      setBusy(false);
      clearTimers();
    });

    eventSource.onerror = () => {
      if (!pollTimer) {
        clearTimers();
        startPolling(jobId);
      }
    };
  } catch (error) {
    startPolling(jobId);
  }
}

function startPolling(jobId) {
  pollTimer = setInterval(async () => {
    try {
      const response = await fetch(`/api/status/${jobId}`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (typeof data.progress === "number") {
        setProgress(data.progress);
      }
      if (data.status) {
        setStatus(`Status: ${data.status}`);
      }
      if (data.status === "done") {
        downloadLink.href = `/api/download/${jobId}`;
        downloadLink.hidden = false;
        mp4CopyButton.hidden = false;
        hlsLink.href = `/api/hls/${jobId}/index.m3u8`;
        hlsLink.hidden = false;
        dashLink.href = `/api/dash/${jobId}/stream.mpd`;
        dashLink.hidden = false;
        hlsCopyButton.hidden = false;
        dashCopyButton.hidden = false;
        setStatus("Done");
        setProgress(100);
        setBusy(false);
        clearTimers();
      }
      if (data.status === "error") {
        setStatus(`Error: ${data.error || "Conversion failed"}`);
        setBusy(false);
        clearTimers();
      }
    } catch (error) {
      setStatus(`Error: ${error.message}`);
      setBusy(false);
      clearTimers();
    }
  }, 1000);
}

function flashStatus(message) {
  setStatus(message);
  setTimeout(() => {
    if (statusText.textContent === message) {
      setStatus("Done");
    }
  }, 2000);
}

function copyText(text) {
  if (!text || text === "#") {
    flashStatus("No link available");
    return Promise.resolve(false);
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }

  const tempInput = document.createElement("input");
  tempInput.value = text;
  document.body.appendChild(tempInput);
  tempInput.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    copied = false;
  }
  document.body.removeChild(tempInput);
  return Promise.resolve(copied);
}

hlsCopyButton.addEventListener("click", async () => {
  const copied = await copyText(hlsLink.href);
  flashStatus(copied ? "Copied HLS link" : "Copy failed");
});

dashCopyButton.addEventListener("click", async () => {
  const copied = await copyText(dashLink.href);
  flashStatus(copied ? "Copied DASH link" : "Copy failed");
});

mp4CopyButton.addEventListener("click", async () => {
  const copied = await copyText(downloadLink.href);
  flashStatus(copied ? "Copied MP4 link" : "Copy failed");
});
