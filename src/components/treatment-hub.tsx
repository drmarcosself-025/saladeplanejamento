import { Eyebrow, GoldButton, PlaceholderMedia } from "@/components/ui";

export type Procedure = {
  name: string;
  description: string;
  points: string[];
};

export function TreatmentHub({
  eyebrow,
  title,
  intro,
  heroImageLabel,
  procedures,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  heroImageLabel: string;
  procedures: Procedure[];
}) {
  return (
    <div>
      <section className="bg-ink text-ivory">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
          <div>
            <Eyebrow tone="ivory">{eyebrow}</Eyebrow>
            <h1 className="font-display mt-3 text-4xl italic leading-tight sm:text-5xl">
              {title}
            </h1>
            <p className="mt-6 max-w-md text-ivory/70">{intro}</p>
            <div className="mt-9">
              <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
            </div>
          </div>
          <PlaceholderMedia label={heroImageLabel} dark />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="space-y-24">
          {procedures.map((procedure, index) => {
            const text = (
              <div key="text">
                <h2 className="font-display text-2xl italic text-ink">
                  {procedure.name}
                </h2>
                <p className="mt-4 text-ink-soft">{procedure.description}</p>
                <ul className="mt-6 space-y-3">
                  {procedure.points.map((point) => (
                    <li key={point} className="flex items-start gap-3 text-sm text-ink-soft">
                      <span className="mt-1 text-gold" aria-hidden>
                        ✓
                      </span>
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            );
            const media = (
              <PlaceholderMedia
                key="media"
                label={`fotografia — ${procedure.name}`}
                ratio="aspect-[4/3]"
              />
            );

            return (
              <div
                key={procedure.name}
                className="grid items-center gap-12 lg:grid-cols-2"
              >
                {index % 2 === 1 ? [media, text] : [text, media]}
              </div>
            );
          })}
        </div>
      </section>

      <section className="border-t border-line bg-surface-2 px-5 py-16 text-center">
        <h2 className="font-display mx-auto max-w-lg text-2xl italic text-ink">
          Cada indicação parte de uma avaliação — não do procedimento que você
          já tinha em mente.
        </h2>
        <div className="mt-8">
          <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
        </div>
      </section>
    </div>
  );
}
