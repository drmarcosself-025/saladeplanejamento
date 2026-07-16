import type { Metadata } from "next";
import { Eyebrow, GoldButton, PlaceholderMedia } from "@/components/ui";
import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Sobre o Doutor",
  description:
    "Trajetória, formação e filosofia clínica de Dr. Marcos Paulo Araújo, especialista em Ortodontia e Harmonização Facial.",
};

const pillars = [
  {
    title: "Excelência técnica",
    text: "Atualização constante em ortodontia e harmonização facial, com planejamento apoiado em tecnologia 3D.",
  },
  {
    title: "Ética profissional",
    text: "Nenhuma indicação de procedimento sem avaliação clínica prévia — a queixa determina a técnica, não o contrário.",
  },
  {
    title: "Cuidado individualizado",
    text: "Cada plano de tratamento é construído para a anatomia e o objetivo específico do paciente.",
  },
];

export default function SobrePage() {
  return (
    <div>
      <section className="mx-auto grid max-w-6xl gap-14 px-5 py-20 lg:grid-cols-2 lg:items-center">
        <div>
          <Eyebrow>Sobre o doutor</Eyebrow>
          <h1 className="font-display mt-3 text-4xl italic text-ink sm:text-5xl">
            {siteConfig.fullName}
          </h1>
          <p className="mt-2 text-ink-faint">{siteConfig.role}</p>
          <p className="mt-2 text-sm text-ink-faint">{siteConfig.cro}</p>

          <div className="mt-8 space-y-4 text-ink-soft">
            <p>
              Atuação há {siteConfig.stats.years} anos na odontologia clínica
              e estética, acumulando experiência sólida, visão moderna e
              domínio técnico em tratamentos de alto padrão.
            </p>
            <p>
              Ao longo da trajetória, já são mais de{" "}
              <strong className="text-ink">
                {siteConfig.stats.patients} pacientes atendidos
              </strong>
              , refletindo confiança, resultados consistentes e satisfação.
            </p>
          </div>

          <div className="mt-10">
            <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
          </div>
        </div>
        <PlaceholderMedia label="retrato institucional, ambiente do consultório" />
      </section>

      {/* Pilares */}
      <section className="border-y border-line bg-surface-2 px-5 py-20">
        <div className="mx-auto max-w-6xl">
          <Eyebrow>Filosofia clínica</Eyebrow>
          <h2 className="font-display mt-3 max-w-xl text-3xl italic text-ink">
            Três pilares que guiam cada consulta.
          </h2>
          <div className="mt-12 grid gap-10 sm:grid-cols-3">
            {pillars.map((pillar) => (
              <div key={pillar.title}>
                <h3 className="font-display text-xl italic text-ink">
                  {pillar.title}
                </h3>
                <p className="mt-3 text-sm text-ink-soft">{pillar.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Formação */}
      <section className="mx-auto max-w-4xl px-5 py-20">
        <Eyebrow>Formação e especialização</Eyebrow>
        <h2 className="font-display mt-3 text-3xl italic text-ink">
          Credenciais
        </h2>
        <ul className="mt-8 space-y-5 border-t border-line pt-8">
          <li className="border-b border-line pb-5">
            <p className="font-semibold text-ink">Graduação em Odontologia</p>
            <p className="mt-1 text-sm text-ink-soft">
              Rede de Ensino Doctum
            </p>
          </li>
          <li className="border-b border-line pb-5">
            <p className="font-semibold text-ink">
              [PREENCHER: pós-graduação/especialização em Ortodontia]
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              [PREENCHER: instituição e ano de conclusão]
            </p>
          </li>
          <li>
            <p className="font-semibold text-ink">
              [PREENCHER: certificação em Harmonização Facial]
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              [PREENCHER: instituição, curso e ano de conclusão]
            </p>
          </li>
        </ul>
        <p className="mt-6 text-xs text-ink-faint">
          Credenciais nominais pesam mais para o seu público do que a
          graduação isolada — substitua os itens acima pelas
          pós-graduações e cursos de especialização reais assim que
          confirmados.
        </p>
      </section>
    </div>
  );
}
