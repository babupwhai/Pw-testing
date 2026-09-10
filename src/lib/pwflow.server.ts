import { escapeHtml } from "@/lib/uploader.server";
import { editMessage, sendMessage, tgCall } from "@/lib/telegram.server";
import {
  batchDetails,
  listLectures,
  listNotes,
  listTopics,
  loadNav,
  playerLink,
  resolveStream,
  saveNav,
  searchBatches,
  type Lecture,
} from "@/lib/pw.server";

type Button = { text: string; callback_data: string };

async function panel(
  chatId: number,
  messageId: number | null,
  text: string,
  keyboard: Button[][],
) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  };
  if (messageId) {
    const edited = await tgCall("editMessageText", { ...payload, message_id: messageId });
    if (edited.ok) return messageId;
  }
  const sent = await tgCall<{ message_id: number }>("sendMessage", payload);
  return sent.ok ? sent.result.message_id : null;
}

function chunkLabel(name: string, max = 45) {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export const BATCH_ID_RE = /^[a-f0-9]{24}$/i;

/** Batch name search — shows tappable results. */
export async function showBatchSearch(chatId: number, query: string) {
  const looking = await sendMessage(chatId, `🔎 <b>${escapeHtml(query)}</b> dhoond raha hoon…`);
  const messageId = looking.ok ? looking.result.message_id : null;
  try {
    const hits = await searchBatches(query);
    if (!hits.length) {
      await panel(chatId, messageId, `❌ "<b>${escapeHtml(query)}</b>" naam ka batch nahi mila.`, []);
      return;
    }
    const rows: Button[][] = [];
    for (const hit of hits.slice(0, 10)) {
      const token = await saveNav({ t: "batch", batchId: hit.id });
      rows.push([{ text: chunkLabel(hit.name), callback_data: `p:b:${token}` }]);
    }
    await panel(chatId, messageId, "📚 <b>Batch choose karo</b>", rows);
  } catch (err) {
    await panel(
      chatId,
      messageId,
      `❌ Site se data nahi aaya: ${escapeHtml(errText(err))}`,
      [],
    );
  }
}

function errText(err: unknown) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 180);
}

export async function showBatch(chatId: number, messageId: number | null, batchId: string) {
  const info = await batchDetails(batchId);
  const rows: Button[][] = [];
  for (const subject of info.subjects) {
    const token = await saveNav({
      t: "subject",
      batchId,
      batchSlug: info.slug,
      subjectSlug: subject.slug,
      subjectId: subject.id,
    });
    rows.push([
      {
        text: `${chunkLabel(subject.name, 32)}${subject.lectures ? ` • ${subject.lectures}` : ""}`,
        callback_data: `p:s:${token}`,
      },
    ]);
  }
  await panel(
    chatId,
    messageId,
    `📦 <b>${escapeHtml(info.name)}</b>\nSubject choose karo:`,
    rows,
  );
}

type SubjectNav = {
  batchId: string;
  batchSlug: string;
  subjectSlug: string;
  subjectId: string;
};

export async function showTopics(
  chatId: number,
  messageId: number | null,
  nav: SubjectNav,
  page = 0,
) {
  const topics = await listTopics(nav.batchId, nav.subjectId);
  const perPage = 8;
  const slice = topics.slice(page * perPage, page * perPage + perPage);
  const rows: Button[][] = [];

  for (const topic of slice) {
    const token = await saveNav({ t: "topic", ...nav, topicId: topic.id, topicName: topic.name });
    rows.push([
      {
        text: `${chunkLabel(topic.name, 30)} • 🎬${topic.videos} 📄${topic.notes}`,
        callback_data: `p:t:${token}`,
      },
    ]);
  }

  const navRow: Button[] = [];
  if (page > 0) {
    const token = await saveNav({ t: "topics", ...nav, page: page - 1 });
    navRow.push({ text: "◀️ Back", callback_data: `p:tp:${token}` });
  }
  if ((page + 1) * perPage < topics.length) {
    const token = await saveNav({ t: "topics", ...nav, page: page + 1 });
    navRow.push({ text: "More ▶️", callback_data: `p:tp:${token}` });
  }
  if (navRow.length) rows.push(navRow);

  await panel(
    chatId,
    messageId,
    topics.length
      ? `📂 <b>Chapters</b> (${page * perPage + 1}-${page * perPage + slice.length} / ${topics.length})`
      : "Is subject me kuch nahi mila.",
    rows,
  );
}

type TopicNav = SubjectNav & { topicId: string; topicName: string };

export async function showTopic(chatId: number, messageId: number | null, nav: TopicNav) {
  const [lectures, notes] = await Promise.all([
    listLectures(nav.batchId, nav.subjectId, nav.topicId),
    listNotes(nav.batchId, nav.subjectId, nav.topicId),
  ]);

  const rows: Button[][] = [];
  for (const lecture of lectures.slice(0, 12)) {
    const token = await saveNav({ t: "lecture", ...nav, lecture });
    rows.push([
      {
        text: `▶️ ${chunkLabel(lecture.name, 34)}${lecture.duration ? ` • ${lecture.duration}` : ""}`,
        callback_data: `p:v:${token}`,
      },
    ]);
  }
  if (notes.length) {
    const token = await saveNav({ t: "notes", ...nav });
    rows.push([{ text: `📄 Notes / PDF (${notes.length})`, callback_data: `p:n:${token}` }]);
  }

  await panel(
    chatId,
    messageId,
    rows.length
      ? `📘 <b>${escapeHtml(nav.topicName)}</b>\nLecture par tap karo — video bot upload karega.`
      : `📘 <b>${escapeHtml(nav.topicName)}</b>\nIsme abhi content nahi hai.`,
    rows,
  );
}

async function queue(
  chatId: number,
  telegramId: number,
  links: { url: string; title?: string }[],
  batchName?: string,
) {
  const bot = await import("@/lib/bot.server");
  await bot.queueForUser(chatId, telegramId, links, batchName);
}

export async function sendNotes(chatId: number, telegramId: number, nav: TopicNav) {
  const [notes, dpp] = await Promise.all([
    listNotes(nav.batchId, nav.subjectId, nav.topicId, "notes"),
    listNotes(nav.batchId, nav.subjectId, nav.topicId, "DppNotes"),
  ]);
  notes.push(...dpp);
  if (!notes.length) {
    await sendMessage(chatId, "📄 Is chapter me koi PDF nahi hai.");
    return;
  }
  await queue(
    chatId,
    telegramId,
    notes.map((n) => ({ url: n.url, title: n.name })),
    nav.topicName,
  );
}

export async function playLecture(
  chatId: number,
  telegramId: number,
  nav: TopicNav & { lecture: Lecture },
) {
  const { lecture } = nav;
  const url = lecture.url ?? "";

  if (/youtube\.com|youtu\.be/i.test(url)) {
    await sendMessage(
      chatId,
      `▶️ <b>${escapeHtml(lecture.name)}</b>\nYe YouTube lecture hai, isliye seedha link:\n${escapeHtml(url)}`,
    );
    return;
  }

  if (/\.m3u8(\?|$)/i.test(url)) {
    await queue(chatId, telegramId, [{ url, title: lecture.name }], nav.topicName);
    return;
  }

  // Protected lectures: backend resolves the signed stream and we upload it.
  try {
    const stream = await resolveStream({
      batchId: nav.batchId,
      subjectId: nav.subjectId,
      videoId: lecture.id,
    });
    if (stream) {
      await queue(chatId, telegramId, [{ url: stream, title: lecture.name }], nav.topicName);
      return;
    }
  } catch (err) {
    await sendMessage(
      chatId,
      `⚠️ <b>${escapeHtml(lecture.name)}</b> ka stream nahi mila: ${escapeHtml(errText(err))}`,
    );
    return;
  }

  const link = playerLink({
    batchId: nav.batchId,
    lecture,
    subjectId: nav.subjectId,
    topicId: nav.topicId,
  });
  await sendMessage(
    chatId,
    [
      `🔒 <b>${escapeHtml(lecture.name)}</b>`,
      "Is lecture ka stream protected (DRM) hai, isliye bot ise upload nahi kar sakta.",
      `Player me dekho: ${escapeHtml(link)}`,
      "",
      "Agar aapke paas iska <code>.m3u8</code> link hai to wo bhejo — main video bana dunga.",
    ].join("\n"),
  );
}

/** Routes every "p:*" inline button. */
export async function handlePwCallback(
  chatId: number,
  messageId: number | null,
  telegramId: number,
  data: string,
  answer: (text?: string) => Promise<unknown>,
): Promise<void> {
  const [, kind, token] = data.split(":");
  if (!kind || !token) {
    await answer();
    return;
  }
  const nav = await loadNav<Record<string, unknown>>(token);
  if (!nav) {
    await answer("Ye menu purana ho gaya, dobara search karo.");
    return;
  }

  try {
    await answer();
    if (kind === "b") {
      await showBatch(chatId, messageId, nav["batchId"] as string);
    } else if (kind === "s") {
      await showTopics(chatId, messageId, nav as unknown as SubjectNav, 0);
    } else if (kind === "tp") {
      await showTopics(
        chatId,
        messageId,
        nav as unknown as SubjectNav,
        (nav["page"] as number) ?? 0,
      );
    } else if (kind === "t") {
      await showTopic(chatId, messageId, nav as unknown as TopicNav);
    } else if (kind === "n") {
      await sendNotes(chatId, telegramId, nav as unknown as TopicNav);
    } else if (kind === "v") {
      await playLecture(chatId, telegramId, nav as unknown as TopicNav & { lecture: Lecture });
    }
  } catch (err) {
    const text = `❌ Kuch galat hua: ${escapeHtml(errText(err))}`;
    if (messageId) await editMessage(chatId, messageId, text);
    else await sendMessage(chatId, text);
  }
}
