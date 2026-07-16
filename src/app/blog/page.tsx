import Link from "next/link";
import type { Metadata } from "next";
import { Eyebrow } from "@/components/ui";
import { getAllPosts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Conteúdo sobre ortodontia, Invisalign e harmonização facial escrito para responder dúvidas reais antes da consulta.",
};

export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <div className="mx-auto max-w-4xl px-5 py-20">
      <Eyebrow>Blog</Eyebrow>
      <h1 className="font-display mt-3 text-4xl italic text-ink sm:text-5xl">
        Antes da consulta, informação real.
      </h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Conteúdo escrito para responder às perguntas que normalmente só
        surgem na cadeira — sem promessa fácil e sem enrolação.
      </p>

      <div className="mt-14 divide-y divide-line border-t border-line">
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="group flex flex-col gap-2 py-8 sm:flex-row sm:items-baseline sm:justify-between"
          >
            <div>
              <span className="eyebrow text-gold">{post.pillar}</span>
              <h2 className="font-display mt-2 text-2xl italic text-ink group-hover:text-gold">
                {post.title}
              </h2>
              <p className="mt-2 max-w-xl text-sm text-ink-soft">
                {post.description}
              </p>
            </div>
            <span className="eyebrow whitespace-nowrap text-ink-faint">
              {post.readingTime}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
