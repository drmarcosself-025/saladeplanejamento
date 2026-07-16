import type { Metadata } from "next";
import { TreatmentHub } from "@/components/treatment-hub";

export const metadata: Metadata = {
  title: "Harmonização Facial",
  description:
    "Toxina botulínica, preenchimento labial e bioestimuladores de colágeno planejados por análise facial individual.",
};

const procedures = [
  {
    name: "Toxina Botulínica",
    description:
      "Indicada para rugas dinâmicas — as que aparecem com a movimentação do rosto, como testa, glabela e ao redor dos olhos.",
    points: [
      "Relaxamento muscular gradual e natural",
      "Procedimento ambulatorial, sem tempo de recuperação",
      "Resultado percebido em até 15 dias",
    ],
  },
  {
    name: "Preenchimento Labial",
    description:
      "Reposição ou redistribuição de volume, planejada para manter proporção com o restante do rosto — não apenas volume por volume.",
    points: [
      "Ácido hialurônico com absorção natural",
      "Planejamento por análise de proporção facial",
      "Resultado imediato, com acomodação em dias",
    ],
  },
  {
    name: "Bioestimuladores de Colágeno",
    description:
      "Estimulam a produção natural de colágeno para resultados mais graduais e duradouros que o preenchimento tradicional.",
    points: [
      "Efeito progressivo ao longo das semanas",
      "Indicado para perda de firmeza e volume",
      "Durabilidade maior que preenchimentos convencionais",
    ],
  },
];

export default function HarmonizacaoFacialPage() {
  return (
    <TreatmentHub
      eyebrow="Harmonização Facial"
      title="Equilíbrio facial planejado, não improvisado."
      intro="Toxina botulínica, preenchimento e bioestimuladores aplicados a partir de uma análise facial completa — a técnica é consequência do diagnóstico, não o ponto de partida."
      heroImageLabel="close-up facial, harmonização"
      procedures={procedures}
    />
  );
}
