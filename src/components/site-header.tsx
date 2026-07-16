"use client";

import Link from "next/link";
import { useState } from "react";
import { navLinks, whatsappHref } from "@/lib/site-config";

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-line/60 bg-ink/95 backdrop-blur supports-[backdrop-filter]:bg-ink/80">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Link
          href="/"
          className="font-display text-lg italic tracking-wide text-ivory"
        >
          M·A
        </Link>

        <nav className="hidden items-center gap-7 lg:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-ivory/80 transition-colors hover:text-gold-on-dark"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden lg:block">
          <Link
            href="/agendamento"
            className="rounded-full bg-gold px-5 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-gold-soft"
          >
            Agendar Avaliação
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-ivory lg:hidden"
          aria-expanded={open}
          aria-label="Abrir menu"
        >
          <span className="eyebrow">{open ? "Fechar" : "Menu"}</span>
        </button>
      </div>

      {open && (
        <div className="border-t border-line/30 px-5 py-4 lg:hidden">
          <nav className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="text-sm text-ivory/85"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/agendamento"
              onClick={() => setOpen(false)}
              className="mt-2 rounded-full bg-gold px-5 py-2.5 text-center text-sm font-semibold text-ink"
            >
              Agendar Avaliação
            </Link>
            <a
              href={whatsappHref("Olá! Gostaria de solicitar uma avaliação.")}
              target="_blank"
              rel="noopener noreferrer"
              className="text-center text-sm text-gold-on-dark underline underline-offset-4"
            >
              Falar no WhatsApp
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
