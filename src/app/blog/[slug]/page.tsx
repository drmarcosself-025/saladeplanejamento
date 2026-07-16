import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import { Eyebrow, GhostLink } from "@/components/ui";
import { getAllPosts, getPostBySlug } from "@/lib/blog";
import { siteConfig } from "@/lib/site-config";

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    openGraph: {
      title: post.title,
      description: post.description,
      type: "article",
      publishedTime: post.date,
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    author: {
      "@type": "Person",
      name: siteConfig.fullName,
    },
  };

  return (
    <article className="mx-auto max-w-3xl px-5 py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <GhostLink href="/blog">Voltar ao blog</GhostLink>

      <Eyebrow>{post.pillar}</Eyebrow>
      <h1 className="font-display mt-3 text-3xl italic text-ink sm:text-4xl">
        {post.title}
      </h1>
      <div className="mt-4 flex items-center gap-3 text-xs text-ink-faint">
        <span>
          {new Date(post.date).toLocaleDateString("pt-BR", {
            day: "2-digit",
            month: "long",
            year: "numeric",
          })}
        </span>
        <span aria-hidden>·</span>
        <span>{post.readingTime} de leitura</span>
      </div>

      <div className="prose-doc mt-10">
        <MDXRemote source={post.content} />
      </div>

      <div className="mt-14 rounded-sm border border-line bg-surface-2 p-6">
        <p className="text-sm text-ink-soft">
          Escrito por{" "}
          <strong className="text-ink">{siteConfig.fullName}</strong> —{" "}
          {siteConfig.role} ({siteConfig.cro})
        </p>
      </div>
    </article>
  );
}
