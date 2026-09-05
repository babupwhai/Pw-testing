export type JobKind = "video" | "document" | "hls" | "auto";

const VIDEO_EXT = [
  ".mp4",
  ".mkv",
  ".mov",
  ".webm",
  ".m4v",
  ".avi",
  ".flv",
  ".ts",
  ".3gp",
];

export function cleanUrl(raw: string): string {
  return raw.trim().replace(/^[<("']+|[>)"',]+$/g, "");
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function detectKind(url: string): Exclude<JobKind, "auto"> {
  const p = pathOf(url);
  if (p.endsWith(".m3u8") || p.includes(".m3u8")) return "hls";
  if (VIDEO_EXT.some((ext) => p.endsWith(ext))) return "video";
  return "document";
}

export function fileNameFromUrl(url: string, fallback = "file"): string {
  try {
    const p = new URL(url).pathname;
    const last = decodeURIComponent(p.split("/").filter(Boolean).pop() ?? "");
    return last || fallback;
  } catch {
    return fallback;
  }
}

export type ParsedLink = { url: string; title?: string };

/**
 * Pulls links out of free text or a .txt file.
 * Supports plain URLs and "Name : https://..." / "Name - https://..." lines.
 */
export function extractLinks(text: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const matches = line.match(/https?:\/\/[^\s"'<>]+/gi);
    if (!matches) continue;
    for (const match of matches) {
      const url = cleanUrl(match);
      if (!isHttpUrl(url) || seen.has(url)) continue;
      seen.add(url);
      const before = line.slice(0, line.indexOf(match)).trim();
      const title = before.replace(/[:\-–—|=]+$/, "").trim();
      out.push(title ? { url, title: title.slice(0, 120) } : { url });
    }
  }
  return out;
}

export function humanSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
