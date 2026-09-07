import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Content site the bot browses (batches → subjects → topics → lectures/notes). */
export const SITE = "https://pwmarco-backup.pages.dev";
const PLAYER = "https://pwxmarco.pages.dev/play.php";

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${SITE}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
      referer: `${SITE}/batches`,
    },
  });
  if (!res.ok) throw new Error(`Site returned ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: unknown };
  if (json.success === false) throw new Error("Site ne data nahi diya");
  return json.data as T;
}

export type BatchHit = { id: string; name: string };

export async function searchBatches(name: string): Promise<BatchHit[]> {
  const data = await api<{ _id: string; name: string }[]>(
    `/api/content/v3/batches/search?name=${encodeURIComponent(name)}&page=1`,
  );
  return (data ?? []).map((b) => ({ id: b._id, name: b.name }));
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
  }>(`/api/content/v3/batches/${batchId}/details`);

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

export async function listTopics(batchSlug: string, subjectSlug: string): Promise<Topic[]> {
  const data = await api<
    { _id: string; name: string; videos?: number; notes?: number; typeId?: string }[]
  >(`/api/content/v2/batches/${batchSlug}/subject/${subjectSlug}/topics`);
  return (data ?? []).map((t) => ({
    id: t._id,
    name: t.name,
    videos: t.videos ?? 0,
    notes: t.notes ?? 0,
    typeId: t.typeId ?? null,
  }));
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
  batchSlug: string,
  subjectSlug: string,
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
    `/api/content/v2/batches/${batchSlug}/subject/${subjectSlug}/contents?page=${page}&contentType=videos&tag=${topicId}`,
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

export type NoteFile = { name: string; url: string };

export async function listNotes(
  batchSlug: string,
  subjectSlug: string,
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
    `/api/content/v2/batches/${batchSlug}/subject/${subjectSlug}/contents?page=1&contentType=${kind}&tag=${topicId}`,
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
