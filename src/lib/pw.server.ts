import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Content APIs the bot browses (batches → subjects → topics → lectures/notes). */
const API = "https://s4-cdn.samfygros.com/radha";
const BATCH_LIST =
  "https://raw.githubusercontent.com/semfy-gros/batches/refs/heads/main/batcha.json";
const DETAIL = "https://video-detail.studyparcham.in/";
const PROXY = "https://proxy.studyparcham.in";
const PLAYER = "https://pwxmarco.pages.dev/play.php";

const BROWSER_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

async function api<T>(path: string): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: BROWSER_HEADERS, cache: "no-store" });
    if (res.ok) {
      const json = (await res.json()) as { success?: boolean; data?: unknown };
      if (json.success === false) throw new Error("Site ne data nahi diya");
      return json.data as T;
    }
    lastErr = `Site returned ${res.status}`;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(lastErr || "Site se data nahi aaya");
}

/**
 * Turns a lecture into a playable .m3u8 link: the detail service returns the
 * DASH master plus its signature, which the proxy serves as HLS.
 */
export async function resolveStream(params: {
  batchId: string;
  subjectId: string;
  videoId: string;
}): Promise<string | null> {
  const q = new URLSearchParams({
    batch_id: params.batchId,
    video_id: params.videoId,
    subject_id: params.subjectId,
  });
  const res = await fetch(`${DETAIL}?${q.toString()}`, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Stream service returned ${res.status}`);
  const json = (await res.json()) as {
    success?: boolean;
    data?: { url?: string; signedUrl?: string };
  };
  const url = json.data?.url;
  if (!json.success || !url) return null;

  const hls = url.replace(/master\.mpd(\?.*)?$/i, "master.m3u8").replace(/^https?:\/\//, "");
  const sig = (json.data?.signedUrl ?? "").replace(/^\?/, "");
  return `${PROXY}/${hls}${sig ? `?${sig}` : ""}`;
}

export type BatchHit = { id: string; name: string };

type CatalogRow = {
  batch_id: string;
  name: string;
  exam?: string | undefined;
  class?: string | undefined;
};
let catalog: { rows: CatalogRow[]; at: number } | null = null;

async function loadCatalog(): Promise<CatalogRow[]> {
  if (catalog && Date.now() - catalog.at < 30 * 60_000) return catalog.rows;
  const res = await fetch(BATCH_LIST, { headers: BROWSER_HEADERS, cache: "no-store" });
  if (!res.ok) throw new Error(`Batch list returned ${res.status}`);
  const json = (await res.json()) as { batches?: CatalogRow[] };
  const rows = (json.batches ?? []).map((b) => ({
    batch_id: b.batch_id,
    name: b.name,
    exam: b.exam,
    class: b.class,
  }));
  catalog = { rows, at: Date.now() };
  return rows;
}

export async function searchBatches(name: string): Promise<BatchHit[]> {
  const rows = await loadCatalog();
  const q = name.toLowerCase().trim();
  const hits = rows.filter((r) => (r.name ?? "").toLowerCase().includes(q));
  return hits.slice(0, 30).map((b) => ({
    id: b.batch_id,
    name: b.class ? `${b.name} (${b.class})` : b.name,
  }));
}

export type BatchSubject = { id: string; slug: string; name: string; lectures: number };
export type BatchInfo = { id: string; name: string; slug: string; subjects: BatchSubject[] };

export async function batchDetails(batchId: string): Promise<BatchInfo> {
  const data = await api<{
    _id: string;
    name: string;
    slug: string;
    subjects?: {
      _id: string;
      slug: string;
      subject: string;
      lectureCount?: number;
    }[];
  }>(`/v3/batches/${batchId}/details`);

  return {
    id: data._id,
    name: data.name,
    slug: data.slug,
    subjects: (data.subjects ?? []).map((s) => ({
      id: s._id,
      slug: s.slug,
      name: s.subject,
      lectures: s.lectureCount ?? 0,
    })),
  };
}

export type Topic = { id: string; name: string; videos: number; notes: number; typeId: string | null };

export async function listTopics(batchId: string, subjectId: string): Promise<Topic[]> {
  const out: Topic[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = await api<
      { _id: string; name: string; videos?: number; notes?: number; typeId?: string }[]
    >(`/v2/batches/${batchId}/subject/${subjectId}/topics?page=${page}`);
    const rows = data ?? [];
    out.push(
      ...rows.map((t) => ({
        id: t._id,
        name: t.name,
        videos: t.videos ?? 0,
        notes: t.notes ?? 0,
        typeId: t.typeId ?? null,
      })),
    );
    if (rows.length < 20) break;
  }
  return out;
}

export type Lecture = {
  id: string;
  name: string;
  url: string;
  urlType: string;
  duration: string | null;
  typeId: string | null;
};

export async function listLectures(
  batchId: string,
  subjectId: string,
  topicId: string,
  page = 1,
): Promise<Lecture[]> {
  const data = await api<
    {
      _id: string;
      topic?: string;
      url?: string;
      urlType?: string;
      typeId?: string;
      videoDetails?: { name?: string; duration?: string };
    }[]
  >(
    `/v2/batches/${batchId}/subject/${subjectId}/contents?page=${page}&contentType=videos&tag=${topicId}`,
  );

  return (data ?? []).map((c) => ({
    id: c._id,
    name: c.videoDetails?.name || c.topic || "Lecture",
    url: c.url ?? "",
    urlType: c.urlType ?? "",
    duration: c.videoDetails?.duration ?? null,
    typeId: c.typeId ?? null,
  }));
}

export type TodayClass = { id: string; name: string; subjectId: string; time: string | null };

export async function listTodaysClasses(batchId: string): Promise<TodayClass[]> {
  const data = await api<
    {
      data?: {
        _id: string;
        topic?: string;
        batchSubjectId?: string;
        startTime?: string;
        isVideoLecture?: boolean;
      };
    }[]
  >(`/v2/batches/${batchId}/todays-schedule`);

  const out: TodayClass[] = [];
  for (const item of data ?? []) {
    const d = item.data;
    if (!d?._id || !d.batchSubjectId) continue;
    out.push({
      id: d._id,
      name: d.topic || "Class",
      subjectId: d.batchSubjectId,
      time: d.startTime ?? null,
    });
  }
  return out;
}

export type NoteFile = { name: string; url: string };

export async function listNotes(
  batchId: string,
  subjectId: string,
  topicId: string,
  kind: "notes" | "DppNotes" = "notes",
): Promise<NoteFile[]> {
  const data = await api<
    {
      homeworkIds?: {
        topic?: string;
        attachmentIds?: { baseUrl?: string; key?: string; name?: string }[];
      }[];
    }[]
  >(
    `/v2/batches/${batchId}/subject/${subjectId}/contents?page=1&contentType=${kind}&tag=${topicId}`,
  );

  const out: NoteFile[] = [];
  for (const item of data ?? []) {
    for (const hw of item.homeworkIds ?? []) {
      for (const att of hw.attachmentIds ?? []) {
        if (!att.baseUrl || !att.key) continue;
        out.push({
          name: att.name || hw.topic || "notes.pdf",
          url: `${att.baseUrl.replace(/\/$/, "")}/${att.key.replace(/^\//, "")}`,
        });
      }
    }
  }
  return out;
}

/** Watch link for lectures the bot cannot upload (DRM / DASH sources). */
export function playerLink(params: {
  batchId: string;
  lecture: Lecture;
  subjectId?: string;
  topicId?: string;
}) {
  const q = new URLSearchParams({
    batch_id: params.batchId,
    subject_id: params.subjectId ?? "",
    topic_id: params.topicId ?? "",
    video_id: params.lecture.id,
    typeId: params.lecture.typeId ?? "",
    video_url: params.lecture.url,
    video_name: params.lecture.name,
    video_type: params.lecture.urlType,
    play_type: "Lecture",
  });
  return `${PLAYER}?${q.toString()}`;
}

/**
 * Inline keyboards only allow 64 bytes of callback data, so every navigation
 * step stores its payload and passes a short token instead.
 */
export async function saveNav(data: Record<string, unknown>): Promise<string> {
  const token = Math.random().toString(36).slice(2, 12);
  await supabaseAdmin.from("pw_nav" as never).insert({ token, data } as never);
  return token;
}

export async function loadNav<T>(token: string): Promise<T | null> {
  const { data } = await (supabaseAdmin.from("pw_nav" as never) as never as {
    select: (c: string) => {
      eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { data: unknown } | null }> };
    };
  })
    .select("data")
    .eq("token", token)
    .maybeSingle();
  return (data?.data as T) ?? null;
}
