import type { Metadata } from "next";
import { IBM_Plex_Mono, Newsreader, Public_Sans } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { siteConfig } from "@/lib/site-config";

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["italic", "normal"],
  weight: ["400", "500", "600"],
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["500"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.domain),
  title: {
    default: `${siteConfig.fullName} | Ortodontia & Harmonização Facial`,
    template: `%s | ${siteConfig.fullName}`,
  },
  description:
    "Ortodontia estética e harmonização facial com planejamento individualizado e resultados naturais.",
  openGraph: {
    type: "website",
    locale: "pt_BR",
    siteName: siteConfig.fullName,
  },
};

// Placeholder fields (marked "[PREENCHER...]" in site-config.ts) must never
// reach structured data — Google would index the literal placeholder text.
function filled(value: string) {
  return value.startsWith("[PREENCHER") ? undefined : value;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dentist",
    name: siteConfig.fullName,
    description:
      "Cirurgião-dentista especializado em Ortodontia e Harmonização Facial.",
    url: siteConfig.domain,
    telephone: filled(siteConfig.phoneDisplay),
    email: filled(siteConfig.email),
    address: {
      "@type": "PostalAddress",
      streetAddress: filled(siteConfig.addressLine),
      addressLocality: filled(siteConfig.city),
      addressCountry: "BR",
    },
    medicalSpecialty: ["Dentistry", "Orthodontics"],
  };

  return (
    <html
      lang="pt-BR"
      className={`${newsreader.variable} ${publicSans.variable} ${plexMono.variable}`}
    >
      <body className="flex min-h-screen flex-col antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
