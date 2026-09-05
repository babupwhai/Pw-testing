import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Marco Uploader — Link se seedha Telegram file" },
      {
        name: "description",
        content:
          "Koi bhi link ya links wali .txt file bhejo aur bot video, PDF ya file seconds me Telegram par bhej deta hai.",
      },
      { property: "og:title", content: "Marco Uploader — Link se seedha Telegram file" },
      {
        property: "og:description",
        content: "Links bhejo, files pao. m3u8 streams bhi video ban ke aate hain.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const steps = [
  { title: "Link bhejo", body: "mp4, pdf, zip, m3u8 — koi bhi direct link chalega." },
  { title: "Bot kaam karta hai", body: "Stream ho to video bana deta hai, warna seedha forward." },
  { title: "File Telegram par", body: "Caption ke saath file, kahin bhi share karo." },
];

function Index() {
  return (
    <main className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-6">
        <span className="font-display text-lg font-bold tracking-tight">Marco Uploader</span>
        <Link to="/auth">
          <Button variant="secondary" size="sm">
            Owner login
          </Button>
        </Link>
      </header>

      <section className="mx-auto max-w-5xl px-5 pb-16 pt-8">
        <p className="mb-4 inline-flex rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          Telegram uploader bot
        </p>
        <h1 className="max-w-2xl text-4xl font-bold leading-tight sm:text-6xl">
          Link do, <span className="text-primary">file</span> lo — seconds me.
        </h1>
        <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
          Ek link ya links wali <code className="font-mono text-foreground">.txt</code> file bhejo.
          Bot har line ka video ya PDF nikal ke Telegram par line by line bhej deta hai.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href="https://t.me/marcouploaderbot" target="_blank" rel="noreferrer">
            <Button size="lg">Bot kholo</Button>
          </a>
          <Link to="/dashboard">
            <Button size="lg" variant="outline">
              Dashboard
            </Button>
          </Link>
        </div>

        <div className="mt-16 grid gap-4 sm:grid-cols-3">
          {steps.map((step, index) => (
            <div key={step.title} className="rounded-lg border border-border bg-card p-5">
              <span className="font-mono text-xs text-primary">0{index + 1}</span>
              <h2 className="mt-2 text-lg font-semibold">{step.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
