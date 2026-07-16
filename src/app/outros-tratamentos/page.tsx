import type { Metadata } from "next";
import { Eyebrow, GoldButton } from "@/components/ui";

export const metadata: Metadata = {
  title: "Outros Tratamentos",
  description:
    "Implante dentário, prótese e clareamento dental — tratamentos complementares de saúde bucal.",
};

const treatments = [
  {
    name: "Implante Dentário",
    description:
      "Reposição de dentes ausentes com estrutura que preserva a estética e a função da mastigação.",
  },
  {
    name: "Prótese / Protocolo",
    description:
      "Reabilitação oral completa para casos de perda dentária extensa, com planejamento funcional e estético.",
  },
  {
    name: "Clareamento Dental",
    description:
      "Clareamento supervisionado, indicado após avaliação da saúde bucal — nunca como primeiro procedimento sem diagnóstico.",
  },
];

export default function OutrosTratamentosPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-20">
      <Eyebrow>Odontologia geral</Eyebrow>
      <h1 className="font-display mt-3 text-4xl italic text-ink">
        Outros tratamentos
      </h1>
      <p className="mt-4 max-w-xl text-ink-soft">
        Tratamentos complementares de saúde bucal, indicados conforme
        avaliação clínica — a base de qualquer plano estético começa por uma
        boca saudável.
      </p>

      <div className="mt-14 divide-y divide-line border-t border-line">
        {treatments.map((treatment) => (
          <div
            key={treatment.name}
            className="flex flex-col gap-2 py-8 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <h2 className="font-display text-xl italic text-ink">
                {treatment.name}
              </h2>
              <p className="mt-2 max-w-lg text-sm text-ink-soft">
                {treatment.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-14">
        <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
      </div>
    </div>
  );
}
