import type { Metadata } from "next";
import { Eyebrow, GoldButton, PlaceholderMedia } from "@/components/ui";

export const metadata: Metadata = {
  title: "Resultados",
  description:
    "Galeria de transformações reais, com contexto de procedimento e prazo — cada caso é único.",
};

const categories = [
  {
    name: "Sorrisos & Ortodontia",
    cases: [
      { procedure: "Invisalign®", timeframe: "planejamento 3D" },
      { procedure: "Ortodontia Estética", timeframe: "acompanhamento contínuo" },
      { procedure: "Facetas", timeframe: "resultado imediato" },
    ],
  },
  {
    name: "Harmonização Facial",
    cases: [
      { procedure: "Preenchimento Labial", timeframe: "resultado imediato" },
      { procedure: "Toxina Botulínica", timeframe: "efeito em até 15 dias" },
      { procedure: "Bioestimulador", timeframe: "efeito progressivo" },
    ],
  },
];

export default function ResultadosPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-20">
      <Eyebrow>Resultados reais</Eyebrow>
      <h1 className="font-display mt-3 text-4xl italic text-ink sm:text-5xl">
        Galeria de transformações
      </h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Cada caso é apresentado com o procedimento realizado e o contexto de
        prazo — resultado de um paciente não é promessa de resultado igual
        para outro.
      </p>

      <div className="mt-6 rounded-sm border border-line bg-surface-2 p-5 text-xs text-ink-faint">
        Placeholder editorial: as fotos abaixo devem ser substituídas por
        casos reais, com consentimento assinado do paciente e enquadramento
        padronizado (mesmo ângulo, distância e iluminação). Confirme a
        conformidade com as normas do CFO sobre uso de imagens antes/depois
        antes de publicar.
      </div>

      <div className="mt-16 space-y-20">
        {categories.map((category) => (
          <div key={category.name}>
            <h2 className="font-display text-2xl italic text-ink">
              {category.name}
            </h2>
            <div className="mt-8 grid gap-6 sm:grid-cols-3">
              {category.cases.map((item) => (
                <div key={item.procedure}>
                  <PlaceholderMedia
                    label={`antes/depois — ${item.procedure}`}
                    ratio="aspect-square"
                  />
                  <p className="mt-3 text-sm font-semibold text-ink">
                    {item.procedure}
                  </p>
                  <p className="text-xs text-ink-faint">{item.timeframe}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-20 border-t border-line pt-14 text-center">
        <h2 className="font-display mx-auto max-w-lg text-2xl italic text-ink">
          Quer entender o que é possível para o seu caso?
        </h2>
        <div className="mt-8">
          <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
        </div>
      </div>
    </div>
  );
}
