"use client";

import { useState, type FormEvent } from "react";
import { whatsappHref } from "@/lib/site-config";

const interests = [
  "Harmonização Facial",
  "Ortodontia / Invisalign",
  "Facetas e Lentes",
  "Implante / Prótese",
  "Ainda não sei — quero uma orientação",
];

export function SchedulingForm() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [interest, setInterest] = useState(interests[0]);
  const [motivation, setMotivation] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = [
      `Olá! Gostaria de solicitar uma avaliação.`,
      `Nome: ${name}`,
      `Telefone para retorno: ${phone}`,
      `Interesse: ${interest}`,
      motivation ? `O que motivou a busca: ${motivation}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    window.open(whatsappHref(message), "_blank", "noopener,noreferrer");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="name" className="eyebrow text-ink-faint">
          Nome
        </label>
        <input
          id="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full border-b border-line bg-transparent py-2 text-ink outline-none focus:border-gold"
          placeholder="Seu nome completo"
        />
      </div>

      <div>
        <label htmlFor="phone" className="eyebrow text-ink-faint">
          Telefone / WhatsApp
        </label>
        <input
          id="phone"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="mt-2 w-full border-b border-line bg-transparent py-2 text-ink outline-none focus:border-gold"
          placeholder="(00) 00000-0000"
        />
      </div>

      <div>
        <label htmlFor="interest" className="eyebrow text-ink-faint">
          Interesse principal
        </label>
        <select
          id="interest"
          value={interest}
          onChange={(e) => setInterest(e.target.value)}
          className="mt-2 w-full border-b border-line bg-transparent py-2 text-ink outline-none focus:border-gold"
        >
          {interests.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="motivation" className="eyebrow text-ink-faint">
          O que motivou a busca? (opcional)
        </label>
        <textarea
          id="motivation"
          value={motivation}
          onChange={(e) => setMotivation(e.target.value)}
          rows={3}
          className="mt-2 w-full resize-none border-b border-line bg-transparent py-2 text-ink outline-none focus:border-gold"
          placeholder="Conte brevemente o que te trouxe até aqui"
        />
      </div>

      <button
        type="submit"
        className="w-full rounded-full bg-gold px-7 py-3 text-sm font-semibold text-ink transition-colors hover:bg-gold-soft"
      >
        Enviar solicitação pelo WhatsApp
      </button>
      <p className="text-xs text-ink-faint">
        Ao enviar, você será direcionado ao WhatsApp com sua solicitação já
        preenchida — a confirmação da avaliação é feita diretamente com a
        equipe do consultório.
      </p>
    </form>
  );
}
