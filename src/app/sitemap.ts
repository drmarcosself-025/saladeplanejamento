import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/blog";
import { siteConfig } from "@/lib/site-config";

const staticRoutes = [
  "",
  "/sobre",
  "/harmonizacao-facial",
  "/ortodontia-invisalign",
  "/outros-tratamentos",
  "/resultados",
  "/consultorio",
  "/blog",
  "/agendamento",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const staticEntries = staticRoutes.map((route) => ({
    url: `${siteConfig.domain}${route}`,
    lastModified: new Date(),
  }));

  const postEntries = getAllPosts().map((post) => ({
    url: `${siteConfig.domain}/blog/${post.slug}`,
    lastModified: new Date(post.date),
  }));

  return [...staticEntries, ...postEntries];
}
