import type { Metadata } from "next";
import { Eyebrow, GoldButton, PlaceholderMedia } from "@/components/ui";
import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Consultório",
  description: "Conheça o ambiente do consultório e a estrutura de atendimento.",
};

const highlights = [
  {
    title: "Atendimento por avaliação",
    text: "Agenda organizada por avaliação prévia, garantindo tempo dedicado a cada caso.",
  },
  {
    title: "Estrutura própria",
    text: "Ambiente planejado para conforto e privacidade durante toda a consulta.",
  },
  {
    title: "Tecnologia de planejamento",
    text: "Ferramentas de simulação digital utilizadas antes da indicação de qualquer procedimento.",
  },
];

export default function ConsultorioPage() {
  return (
    <div>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
        <div>
          <Eyebrow>Consultório</Eyebrow>
          <h1 className="font-display mt-3 text-4xl italic text-ink sm:text-5xl">
            Um ambiente pensado para a consulta, não só para o procedimento.
          </h1>
          <p className="mt-6 text-ink-soft">{siteConfig.addressLine}</p>
          <div className="mt-9">
            <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
          </div>
        </div>
        <PlaceholderMedia label="fachada ou recepção do consultório" ratio="aspect-[4/3]" />
      </section>

      <section className="border-y border-line bg-surface-2 px-5 py-20">
        <div className="mx-auto max-w-6xl grid gap-10 sm:grid-cols-3">
          {highlights.map((item) => (
            <div key={item.title}>
              <h3 className="font-display text-xl italic text-ink">
                {item.title}
              </h3>
              <p className="mt-3 text-sm text-ink-soft">{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="grid gap-6 sm:grid-cols-2">
          <PlaceholderMedia label="sala de atendimento" ratio="aspect-square" />
          <PlaceholderMedia label="sala de espera" ratio="aspect-square" />
        </div>
      </section>
    </div>
  );
}
