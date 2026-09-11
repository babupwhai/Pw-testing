import muxjs from "mux.js";

type Bytes = Uint8Array<ArrayBuffer>;

function resolve(base: string, ref: string) {
  return new URL(ref, base).toString();
}

/** Retries rate limits / hiccups instead of failing the whole lecture. */
async function fetchRetry(url: string, tries = 4): Promise<Response> {
  let last = "";
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
      if (res.ok) return res;
      last = String(res.status);
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`Fetch failed (${last})`);
}

async function fetchText(url: string) {
  return (await fetchRetry(url)).text();
}

async function estimateMediaBytes(media: MediaPlaylist, durationSec: number): Promise<number | null> {
  if (!media.segments.length || !durationSec) return null;
  const sampleCount = Math.min(32, media.segments.length);
  const indexes = Array.from({ length: sampleCount }, (_, index) =>
    Math.min(media.segments.length - 1, Math.floor((index * media.segments.length) / sampleCount)),
  );
  const samples = await Promise.all(
    indexes.map(async (index) => {
      try {
        const response = await fetch(media.segments[index]!, {
          method: "HEAD",
          headers: { "user-agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(4_000),
        });
        const bytes = Number(response.headers.get("content-length") ?? 0);
        const seconds = media.durations[index] ?? 0;
        return response.ok && bytes > 0 && seconds > 0 ? { bytes, seconds } : null;
      } catch {
        return null;
      }
    }),
  );
  const valid = samples.filter((sample): sample is { bytes: number; seconds: number } => Boolean(sample));
  if (valid.length < Math.min(6, sampleCount)) return null;
  const sampledBytes = valid.reduce((sum, sample) => sum + sample.bytes, 0);
  const sampledSeconds = valid.reduce((sum, sample) => sum + sample.seconds, 0);
  return Math.round((sampledBytes / sampledSeconds) * durationSec);
}

async function fetchBytes(url: string): Promise<Bytes> {
  const res = await fetchRetry(url);
  return new Uint8Array(await res.arrayBuffer()) as Bytes;
}

function hexToBytes(hex: string): Bytes {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2)) as Bytes;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function ivForSequence(seq: number): Bytes {
  const iv = new Uint8Array(new ArrayBuffer(16)) as Bytes;
  new DataView(iv.buffer).setUint32(12, seq);
  return iv;
}

function concat(chunks: Bytes[]): Bytes {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total)) as Bytes;
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/* ------------------------------- playlists ------------------------------- */

export type StreamVariant = {
  url: string;
  bandwidth: number;
  resolution: string | null;
  label: string;
  estBytes: number | null;
  durationSec: number | null;
};

export type StreamInfo = { variants: StreamVariant[]; durationSec: number | null };

type MediaPlaylist = {
  segments: string[];
  durations: number[];
  initSegment?: string;
  key?: { url: string; iv: Bytes | undefined };
};

function parseMaster(text: string, base: string): StreamVariant[] {
  const lines = text.split(/\r?\n/);
  const variants: StreamVariant[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bandwidth = Number(
      /(?:AVERAGE-)?BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0,
    );
    const resolution = /RESOLUTION=(\d+x\d+)/.exec(line)?.[1] ?? null;
    const next = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (!next) continue;
    const height = resolution ? Number(resolution.split("x")[1]) : null;
    variants.push({
      url: resolve(base, next.trim()),
      bandwidth,
      resolution,
      label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : "auto",
      estBytes: null,
      durationSec: null,
    });
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

function parseMedia(text: string, base: string): MediaPlaylist {
  const out: MediaPlaylist = { segments: [], durations: [] };
  let pending = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      pending = Number(/#EXTINF:([\d.]+)/.exec(line)?.[1] ?? 0);
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) out.initSegment = resolve(base, uri);
      continue;
    }
    if (line.startsWith("#EXT-X-KEY")) {
      const method = /METHOD=([A-Z0-9-]+)/.exec(line)?.[1];
      if (!method || method === "NONE") continue;
      if (method !== "AES-128") throw new Error(`Encrypted stream (${method}) not supported`);
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      const ivHex = /IV=0x([0-9A-Fa-f]+)/.exec(line)?.[1];
      if (uri) out.key = { url: resolve(base, uri), iv: ivHex ? hexToBytes(ivHex) : undefined };
      continue;
    }
    if (line.startsWith("#")) continue;
    out.segments.push(resolve(base, line));
    out.durations.push(pending);
    pending = 0;
  }
  return out;
}

/** Lists the qualities in a stream with an estimated size for each. */
export async function probeStream(url: string): Promise<StreamInfo> {
  const text = await fetchText(url);
  const variants = text.includes("#EXT-X-STREAM-INF") ? parseMaster(text, url) : [];

  if (!variants.length) {
    const media = parseMedia(text, url);
    const durationSec = media.durations.reduce((a, b) => a + b, 0) || null;
    return {
      durationSec,
      variants: [
        {
          url,
          bandwidth: 0,
          resolution: null,
          label: "Original",
          estBytes: null,
          durationSec,
        },
      ],
    };
  }

  let durationSec: number | null = null;
  try {
    const probeUrl = variants[0]!.url;
    const media = parseMedia(await fetchText(probeUrl), probeUrl);
    durationSec = media.durations.reduce((a, b) => a + b, 0) || null;
  } catch {
    durationSec = null;
  }

  await Promise.all(
    variants.map(async (variant) => {
      if (!durationSec) return;
      variant.durationSec = durationSec;
      try {
        const media = parseMedia(await fetchText(variant.url), variant.url);
        variant.estBytes =
          (await estimateMediaBytes(media, durationSec)) ??
          (variant.bandwidth ? Math.round((variant.bandwidth / 8) * durationSec) : null);
      } catch {
        variant.estBytes = variant.bandwidth
          ? Math.round((variant.bandwidth / 8) * durationSec)
          : null;
      }
    }),
  );
  return { variants, durationSec };
}

/* --------------------------------- parts --------------------------------- */

export type PartResult = {
  bytes: Bytes;
  nextIndex: number;
  totalSegments: number;
  done: boolean;
  outOfTime: boolean;
};

/**
 * Builds ONE playable MP4 chunk starting at `startIndex`, stopping at `maxBytes`
 * (or when the time budget runs out). Call repeatedly with `nextIndex` to walk a
 * stream of any length — each chunk is a standalone video.
 */
export async function buildPart(
  mediaUrl: string,
  startIndex: number,
  maxBytes: number,
  deadline: number,
  onProgress?: (done: number, total: number) => void,
): Promise<PartResult> {
  let text = await fetchText(mediaUrl);
  let url = mediaUrl;
  if (text.includes("#EXT-X-STREAM-INF")) {
    const best = parseMaster(text, mediaUrl)[0];
    if (!best) throw new Error("No playable stream found in playlist");
    url = best.url;
    text = await fetchText(url);
  }
  const playlist = parseMedia(text, url);
  if (!playlist.segments.length) throw new Error("Playlist has no segments");

  const total = playlist.segments.length;
  if (startIndex >= total) {
    return {
      bytes: new Uint8Array(new ArrayBuffer(0)) as Bytes,
      nextIndex: total,
      totalSegments: total,
      done: true,
      outOfTime: false,
    };
  }

  let keyBytes: ArrayBuffer | null = null;
  if (playlist.key) {
    const res = await fetch(playlist.key.url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error("Could not fetch stream key");
    keyBytes = await res.arrayBuffer();
  }

  const isFmp4 = Boolean(playlist.initSegment);
  const out: Bytes[] = [];
  let raw = 0;
  let index = startIndex;
  let outOfTime = false;

  const transmuxer = isFmp4
    ? null
    : new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: false });
  if (transmuxer) {
    transmuxer.on("data", (segment: { initSegment: Uint8Array; data: Uint8Array }) => {
      out.push(new Uint8Array(segment.initSegment) as Bytes);
      out.push(new Uint8Array(segment.data) as Bytes);
    });
  }

  if (playlist.initSegment) {
    const init = await fetchBytes(playlist.initSegment);
    out.push(init);
  }

  const CONCURRENCY = 12;
  while (index < total) {
    // Keep going a little past the soft deadline so a part is never tiny.
    if (Date.now() > deadline && raw >= maxBytes * 0.7) {
      outOfTime = true;
      break;
    }
    if (Date.now() > deadline + 45_000) {
      outOfTime = true;
      break;
    }
    const slice = playlist.segments.slice(index, index + CONCURRENCY);
    const fetched = await Promise.all(slice.map((s) => fetchBytes(s)));

    let stop = false;
    for (let j = 0; j < fetched.length; j += 1) {
      let data = fetched[j]!;
      if (keyBytes && playlist.key) {
        const iv = playlist.key.iv ?? ivForSequence(index + j);
        const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, [
          "decrypt",
        ]);
        data = new Uint8Array(
          await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, data),
        ) as Bytes;
      }

      if (transmuxer) transmuxer.push(data);
      else out.push(data);

      raw += data.length;
      index += 1;
      onProgress?.(index, total);

      if (raw >= maxBytes) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }

  if (transmuxer) transmuxer.flush();

  return {
    bytes: concat(out),
    nextIndex: index,
    totalSegments: total,
    done: index >= total,
    outOfTime,
  };
}
