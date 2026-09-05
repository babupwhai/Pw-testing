import muxjs from "mux.js";

const MAX_BYTES = 48 * 1024 * 1024; // Telegram bot upload ceiling (~50MB)

type Variant = { bandwidth: number; url: string };

function resolve(base: string, ref: string) {
  return new URL(ref, base).toString();
}

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status})`);
  return res.text();
}

async function fetchBytes(url: string) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Segment fetch failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function pickVariant(text: string, base: string): string | null {
  const lines = text.split(/\r?\n/);
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
    const next = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (next) variants.push({ bandwidth: bw, url: resolve(base, next.trim()) });
  }
  if (!variants.length) return null;
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants[0]!.url;
}

type Bytes = Uint8Array<ArrayBuffer>;

type MediaPlaylist = {
  segments: string[];
  initSegment?: string;
  key?: { url: string; iv: Bytes | undefined };
};


function parseMedia(text: string, base: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const out: MediaPlaylist = { segments: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
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
      if (uri) {
        out.key = {
          url: resolve(base, uri),
          iv: ivHex ? hexToBytes(ivHex) : undefined,
        };
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    out.segments.push(resolve(base, line));
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function ivForSequence(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq);
  return iv;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export type HlsResult = { bytes: Uint8Array; segments: number; truncated: boolean };

/**
 * Downloads an HLS playlist and produces one playable MP4 in memory.
 * MPEG-TS segments are remuxed to fragmented MP4; fMP4 segments are joined as-is.
 */
export async function hlsToMp4(
  url: string,
  onProgress?: (done: number, total: number) => void,
): Promise<HlsResult> {
  const master = await fetchText(url);
  let mediaUrl = url;
  let mediaText = master;
  if (master.includes("#EXT-X-STREAM-INF")) {
    const variant = pickVariant(master, url);
    if (!variant) throw new Error("No playable stream found in playlist");
    mediaUrl = variant;
    mediaText = await fetchText(variant);
  }

  const playlist = parseMedia(mediaText, mediaUrl);
  if (!playlist.segments.length) throw new Error("Playlist has no segments");

  let keyBytes: ArrayBuffer | null = null;
  if (playlist.key) {
    const res = await fetch(playlist.key.url);
    if (!res.ok) throw new Error("Could not fetch stream key");
    keyBytes = await res.arrayBuffer();
  }

  const isFmp4 = Boolean(playlist.initSegment);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let processed = 0;

  const transmuxer = isFmp4
    ? null
    : new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: true });
  if (transmuxer) {
    transmuxer.on("data", (segment: { initSegment: Uint8Array; data: Uint8Array }) => {
      chunks.push(new Uint8Array(segment.initSegment));
      chunks.push(new Uint8Array(segment.data));
      total += segment.initSegment.length + segment.data.length;
    });
  }

  if (playlist.initSegment) {
    const init = await fetchBytes(playlist.initSegment);
    chunks.push(init);
    total += init.length;
  }

  const CONCURRENCY = 6;
  const segments = playlist.segments;

  for (let i = 0; i < segments.length && !truncated; i += CONCURRENCY) {
    const slice = segments.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(slice.map((s) => fetchBytes(s)));

    for (let j = 0; j < fetched.length; j += 1) {
      let data = fetched[j]!;
      if (keyBytes && playlist.key) {
        const iv = playlist.key.iv ?? ivForSequence(i + j);
        const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, [
          "decrypt",
        ]);
        const plain = await crypto.subtle.decrypt(
          { name: "AES-CBC", iv },
          cryptoKey,
          data as unknown as BufferSource,
        );
        data = new Uint8Array(plain);
      }

      if (transmuxer) {
        transmuxer.push(data);
        transmuxer.flush();
      } else {
        chunks.push(data);
        total += data.length;
      }

      processed += 1;
      onProgress?.(processed, segments.length);

      if (total > MAX_BYTES) {
        truncated = true;
        break;
      }
    }
  }

  return { bytes: concat(chunks), segments: processed, truncated };
}
