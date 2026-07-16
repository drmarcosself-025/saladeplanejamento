import Link from "next/link";
import { Eyebrow, GhostLink, GoldButton, PlaceholderMedia } from "@/components/ui";
import { getAllPosts } from "@/lib/blog";
import { siteConfig } from "@/lib/site-config";

const process = [
  {
    step: "01",
    title: "Escuta da queixa",
    text: "Entendemos o que motivou a busca antes de falar de qualquer procedimento.",
  },
  {
    step: "02",
    title: "Análise facial",
    text: "Avaliação de proporções e simetria, considerando o rosto como um conjunto.",
  },
  {
    step: "03",
    title: "Plano de tratamento",
    text: "Indicação técnica com prazo, alternativas e justificativa clínica.",
  },
  {
    step: "04",
    title: "Execução e acompanhamento",
    text: "Procedimento realizado com retorno agendado para avaliar o resultado.",
  },
];

const pillars = [
  {
    href: "/harmonizacao-facial",
    title: "Harmonização Facial",
    text: "Toxina botulínica, preenchimento e bioestimuladores planejados por análise facial individual.",
  },
  {
    href: "/ortodontia-invisalign",
    title: "Ortodontia & Invisalign",
    text: "Alinhadores transparentes e ortodontia estética com tecnologia 3D de planejamento.",
  },
  {
    href: "/outros-tratamentos",
    title: "Outros Tratamentos",
    text: "Implante, prótese e clareamento dental para complementar sua saúde bucal.",
  },
];

export default function Home() {
  const posts = getAllPosts().slice(0, 3);

  return (
    <>
      {/* Hero */}
      <section className="bg-ink text-ivory">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <p className="text-xl text-ivory/60">Sorrisos e faces em harmonia.</p>
            <h1 className="font-display mt-2 text-4xl italic leading-tight sm:text-5xl">
              Resultados naturais, planejados com precisão.
            </h1>
            <p className="mt-6 text-ivory/70">
              Especialista em Ortodontia &amp;{" "}
              <em className="font-display not-italic text-gold-on-dark">
                Harmonização Facial
              </em>
              .
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-6">
              <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
              <GhostLink href="/resultados" light>
                Ver resultados
              </GhostLink>
            </div>
          </div>
          <PlaceholderMedia
            label="retrato institucional do doutor, preto e branco"
            ratio="aspect-[4/5]"
            dark
          />
        </div>
      </section>

      {/* Quote */}
      <section className="border-b border-line bg-surface-2 px-5 py-14 text-center">
        <p className="font-display mx-auto max-w-2xl text-xl italic text-ink sm:text-2xl">
          &ldquo;Transformar a harmonia do rosto e do sorriso, com naturalidade
          e precisão, é minha essência.&rdquo;
        </p>
        <p className="eyebrow mt-4 text-ink-faint">{siteConfig.fullName}</p>
      </section>

      {/* Sobre resumido */}
      <section className="mx-auto grid max-w-6xl gap-12 px-5 py-20 lg:grid-cols-2 lg:items-center">
        <PlaceholderMedia label="retrato de perfil, ambiente neutro" />
        <div>
          <Eyebrow>Sobre o doutor</Eyebrow>
          <h2 className="font-display mt-3 text-3xl italic text-ink">
            {siteConfig.fullName}
          </h2>
          <p className="mt-2 text-sm text-ink-faint">{siteConfig.role}</p>
          <p className="mt-5 text-ink-soft">
            Atuação clínica pautada em três pilares: excelência técnica,
            ética profissional e cuidado individualizado. Cada avaliação é
            planejada estrategicamente para garantir segurança,
            previsibilidade e resultados que respeitam a anatomia de cada
            paciente.
          </p>
          <div className="mt-8 flex gap-10 border-t border-line pt-6">
            <div>
              <p className="font-display text-2xl italic text-ink">
                {siteConfig.stats.years} anos
              </p>
              <p className="eyebrow mt-1 text-ink-faint">Experiência</p>
            </div>
            <div>
              <p className="font-display text-2xl italic text-ink">
                {siteConfig.stats.patients}
              </p>
              <p className="eyebrow mt-1 text-ink-faint">Pacientes atendidos</p>
            </div>
          </div>
          <div className="mt-8">
            <GhostLink href="/sobre">Conhecer a trajetória completa</GhostLink>
          </div>
        </div>
      </section>

      {/* Processo */}
      <section className="border-y border-line bg-surface-2 px-5 py-20">
        <div className="mx-auto max-w-6xl">
          <Eyebrow>Como trabalhamos</Eyebrow>
          <h2 className="font-display mt-3 max-w-xl text-3xl italic text-ink">
            Todo procedimento começa por um diagnóstico, nunca por um pedido.
          </h2>
          <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {process.map((item) => (
              <div key={item.step}>
                <span className="font-display text-3xl italic text-gold">
                  {item.step}
                </span>
                <h3 className="mt-3 font-semibold text-ink">{item.title}</h3>
                <p className="mt-2 text-sm text-ink-soft">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pilares de tratamento */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <Eyebrow>Tratamentos</Eyebrow>
        <h2 className="font-display mt-3 max-w-xl text-3xl italic text-ink">
          Dois focos, um mesmo padrão de precisão.
        </h2>
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {pillars.map((pillar) => (
            <Link
              key={pillar.href}
              href={pillar.href}
              className="group flex flex-col justify-between rounded-sm border border-line bg-surface p-7 transition-colors hover:border-gold"
            >
              <div>
                <h3 className="font-display text-xl italic text-ink group-hover:text-gold">
                  {pillar.title}
                </h3>
                <p className="mt-3 text-sm text-ink-soft">{pillar.text}</p>
              </div>
              <span className="eyebrow mt-8 text-ink-faint group-hover:text-gold">
                Saiba mais →
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* Resultados */}
      <section className="bg-ink px-5 py-20 text-ivory">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <Eyebrow tone="ivory">Resultados reais</Eyebrow>
              <h2 className="font-display mt-3 text-3xl italic">
                Cada caso, com contexto e critério.
              </h2>
            </div>
            <GhostLink href="/resultados" light>
              Ver galeria completa
            </GhostLink>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <PlaceholderMedia
              label="antes/depois — ortodontia"
              ratio="aspect-square"
              dark
            />
            <PlaceholderMedia
              label="antes/depois — harmonização"
              ratio="aspect-square"
              dark
            />
            <PlaceholderMedia
              label="antes/depois — clareamento"
              ratio="aspect-square"
              dark
            />
          </div>
        </div>
      </section>

      {/* Blog preview */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Eyebrow>Blog</Eyebrow>
            <h2 className="font-display mt-3 text-3xl italic text-ink">
              Informação antes da consulta.
            </h2>
          </div>
          <GhostLink href="/blog">Ver todos os artigos</GhostLink>
        </div>
        <div className="mt-12 grid gap-8 lg:grid-cols-3">
          {posts.map((post) => (
            <Link key={post.slug} href={`/blog/${post.slug}`} className="group">
              <span className="eyebrow text-gold">{post.pillar}</span>
              <h3 className="font-display mt-2 text-lg italic text-ink group-hover:text-gold">
                {post.title}
              </h3>
              <p className="mt-2 text-sm text-ink-soft">{post.description}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* CTA final */}
      <section className="border-t border-line bg-surface-2 px-5 py-20 text-center">
        <h2 className="font-display mx-auto max-w-xl text-3xl italic text-ink">
          O primeiro passo é uma avaliação, não uma decisão.
        </h2>
        <p className="mt-4 text-ink-soft">
          Agende um horário e entenda, com clareza, o que faz sentido para o
          seu caso.
        </p>
        <div className="mt-8">
          <GoldButton href="/agendamento">Agendar Avaliação</GoldButton>
        </div>
      </section>
    </>
  );
}
