import Link from "next/link";
import { navLinks, siteConfig } from "@/lib/site-config";

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-ink text-ivory/70">
      <div className="mx-auto max-w-6xl px-5 py-14">
        <div className="grid gap-10 sm:grid-cols-3">
          <div>
            <p className="font-display text-xl italic text-ivory">
              {siteConfig.shortName}
            </p>
            <p className="mt-2 text-sm">{siteConfig.role}</p>
            <p className="mt-4 text-xs text-ivory/50">{siteConfig.cro}</p>
          </div>

          <div>
            <span className="eyebrow text-gold-on-dark">Navegação</span>
            <ul className="mt-3 space-y-2 text-sm">
              {navLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-gold-on-dark">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <span className="eyebrow text-gold-on-dark">Contato</span>
            <ul className="mt-3 space-y-2 text-sm">
              <li>{siteConfig.phoneDisplay}</li>
              <li>{siteConfig.email}</li>
              <li>{siteConfig.addressLine}</li>
              <li>{siteConfig.instagram}</li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-ivory/10 pt-6 text-xs text-ivory/40 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {siteConfig.shortName}. Todos os
            direitos reservados.
          </p>
          <p>{siteConfig.cro}</p>
        </div>
      </div>
    </footer>
  );
}
