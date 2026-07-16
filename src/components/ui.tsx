import Link from "next/link";
import type { ReactNode } from "react";

export function Eyebrow({
  children,
  tone = "gold",
}: {
  children: ReactNode;
  tone?: "gold" | "ivory";
}) {
  return (
    <span
      className={`eyebrow block ${
        tone === "gold" ? "text-gold" : "text-ivory/70"
      }`}
    >
      {children}
    </span>
  );
}

export function GoldButton({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-full bg-gold px-7 py-3 text-sm font-semibold text-ink transition-colors hover:bg-gold-soft"
    >
      {children}
    </Link>
  );
}

export function GhostLink({
  href,
  children,
  light = false,
}: {
  href: string;
  children: ReactNode;
  light?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`eyebrow inline-flex items-center gap-2 border-b pb-1 transition-colors ${
        light
          ? "border-ivory/40 text-ivory/80 hover:border-gold-on-dark hover:text-gold-on-dark"
          : "border-ink/30 text-ink-soft hover:border-gold hover:text-gold"
      }`}
    >
      {children}
      <span aria-hidden>→</span>
    </Link>
  );
}

/**
 * Bloco de espaço reservado para fotografia real (retrato, ambiente,
 * antes/depois). Nunca deve ser substituído por imagens de banco
 * genéricas — a identidade da marca depende de fotografia própria e
 * consistente.
 */
export function PlaceholderMedia({
  label,
  ratio = "aspect-[4/5]",
  dark = false,
}: {
  label: string;
  ratio?: string;
  dark?: boolean;
}) {
  return (
    <div
      className={`relative flex ${ratio} w-full items-center justify-center overflow-hidden rounded-sm border ${
        dark
          ? "border-ivory/15 bg-[linear-gradient(135deg,#221e15_0%,#17140f_60%)]"
          : "border-line bg-[linear-gradient(135deg,#f0ead9_0%,#e2dcc9_100%)]"
      }`}
    >
      <div
        className={`absolute inset-0 opacity-[0.06] ${dark ? "bg-ivory" : "bg-ink"}`}
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 14px)",
        }}
      />
      <div className="relative flex flex-col items-center gap-3 px-6 text-center">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          className={dark ? "text-ivory/40" : "text-ink-faint"}
        >
          <path
            d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.13a1 1 0 0 0 .87-.5l.6-1A1.5 1.5 0 0 1 10.37 5h3.26a1.5 1.5 0 0 1 1.27.75l.6 1a1 1 0 0 0 .87.5h2.13A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5.5A1.5 1.5 0 0 1 4 17.5v-9Z"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <p
          className={`eyebrow ${dark ? "text-ivory/45" : "text-ink-faint"}`}
        >
          Foto: {label}
        </p>
      </div>
    </div>
  );
}
