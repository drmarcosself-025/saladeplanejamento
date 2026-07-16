import type { Metadata } from "next";
import { TreatmentHub } from "@/components/treatment-hub";

export const metadata: Metadata = {
  title: "Ortodontia & Invisalign",
  description:
    "Alinhadores transparentes Invisalign® e ortodontia estética planejados com tecnologia 3D para resultados previsíveis.",
};

const procedures = [
  {
    name: "Invisalign®",
    description:
      "Alinhadores transparentes e removíveis, planejados digitalmente antes mesmo do primeiro alinhador ser instalado.",
    points: [
      "Discreto e praticamente invisível",
      "Removível para comer e higienizar",
      "Mais confortável que aparelhos fixos",
      "Planejamento com tecnologia 3D e simulação de resultado",
    ],
  },
  {
    name: "Ortodontia Estética",
    description:
      "Para quem prefere aparelho fixo, opções estéticas discretas sem abrir mão da precisão do movimento dentário.",
    points: [
      "Bráquetes estéticos de baixa visibilidade",
      "Acompanhamento próximo a cada retorno",
      "Planejamento com previsão de tempo de tratamento",
    ],
  },
  {
    name: "Facetas e Lentes de Contato Dental",
    description:
      "Para correção estética de forma, cor e alinhamento aparente, quando o objetivo vai além do posicionamento dentário.",
    points: [
      "Indicação após avaliação de proporção e cor",
      "Preparo minimamente invasivo",
      "Planejamento estético prévio",
    ],
  },
];

export default function OrtodontiaPage() {
  return (
    <TreatmentHub
      eyebrow="Ortodontia & Invisalign"
      title="Movimento dentário com previsibilidade."
      intro="Cada plano ortodôntico começa com simulação digital do resultado — você entende o que esperar antes de começar o tratamento."
      heroImageLabel="paciente com alinhador transparente"
      procedures={procedures}
    />
  );
}
