import express from "express";
import WebTorrent from "webtorrent";
import cors from "cors";

const app = express();
const client = new WebTorrent();
const PORT = process.env.PORT || 3000;

// ─── CORS — allow your NOVA app to call this server ──────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── In-memory cache: infoHash → torrent ─────────────────────────────────────
const cache = new Map();

// ─── Health check — StreamResolver pings this to verify server is alive ──────
app.get("/health", (req, res) => {
  res.json({ status: "ok", torrents: client.torrents.length });
});

// ─── Stream endpoint ──────────────────────────────────────────────────────────
app.get("/stream", (req, res) => {
  const { infoHash, fileIndex = 0 } = req.query;

  if (!infoHash) {
    return res.status(400).json({ error: "infoHash is required" });
  }

  const magnetUri = `magnet:?xt=urn:btih:${infoHash}`;
  const idx = parseInt(fileIndex);

  const startStream = (torrent) => {
    // Find target file — use fileIndex or fall back to largest file (the video)
    const file =
      torrent.files[idx] ||
      torrent.files.reduce((a, b) => (a.length > b.length ? a : b));

    if (!file) {
      return res.status(404).json({ error: "No video file found in torrent" });
    }

    const fileSize = file.length;
    const range = req.headers.range;

    // No range header — send file info (some players probe first)
    if (!range) {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": getMimeType(file.name),
        "Accept-Ranges": "bytes",
      });
      const stream = file.createReadStream();
      req.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }

    // Parse range header (e.g. "bytes=0-1023")
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": getMimeType(file.name),
    });

    const stream = file.createReadStream({ start, end });
    req.on("close", () => stream.destroy());
    stream.on("error", (err) => {
      console.error("Stream error:", err.message);
      res.end();
    });
    stream.pipe(res);
  };

  // Already cached?
  if (cache.has(infoHash)) {
    return startStream(cache.get(infoHash));
  }

  // Check if WebTorrent already has it
  const existing = client.get(infoHash);
  if (existing) {
    cache.set(infoHash, existing);
    return startStream(existing);
  }

  // Add new torrent
  console.log(`Adding torrent: ${infoHash}`);

  const torrent = client.add(magnetUri, { path: "/tmp/nova" }, (t) => {
    console.log(`Torrent ready: ${t.name}`);
    cache.set(infoHash, t);
    startStream(t);
  });

  torrent.on("error", (err) => {
    console.error("Torrent error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to load torrent: " + err.message });
    }
  });

  // Timeout if metadata takes too long
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Torrent metadata timeout. Try again." });
    }
  }, 30000);

  torrent.on("metadata", () => clearTimeout(timeout));
});

// ─── Cleanup: remove old torrents to save memory ──────────────────────────────
setInterval(() => {
  if (client.torrents.length > 8) {
    const oldest = client.torrents[0];
    console.log(`Removing old torrent: ${oldest.name}`);
    cache.delete(oldest.infoHash);
    client.remove(oldest);
  }
}, 5 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getMimeType(filename = "") {
  const ext = filename.split(".").pop().toLowerCase();
  const types = {
    mp4: "video/mp4",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    webm: "video/webm",
    m4v: "video/mp4",
  };
  return types[ext] || "video/mp4";
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎬 NOVA Stream Server running on port ${PORT}`);
});

process.on("SIGTERM", () => client.destroy(() => process.exit(0)));
