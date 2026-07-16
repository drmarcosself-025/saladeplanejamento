import type { Metadata } from "next";
import { Eyebrow } from "@/components/ui";
import { SchedulingForm } from "@/components/scheduling-form";
import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Agendar Avaliação",
  description:
    "Solicite sua avaliação de Ortodontia ou Harmonização Facial com Dr. Marcos Paulo Araújo.",
};

export default function AgendamentoPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-16 px-5 py-20 lg:grid-cols-2">
      <div>
        <Eyebrow>Agendamento</Eyebrow>
        <h1 className="font-display mt-3 text-4xl italic text-ink">
          Solicitar avaliação
        </h1>
        <p className="mt-4 max-w-md text-ink-soft">
          Preencha os dados abaixo para iniciar a conversa. A avaliação é o
          primeiro passo — nela definimos, juntos, o que faz sentido para o
          seu caso.
        </p>
        <div className="mt-10 space-y-3 border-t border-line pt-8 text-sm text-ink-soft">
          <p>{siteConfig.phoneDisplay}</p>
          <p>{siteConfig.addressLine}</p>
          <p>{siteConfig.instagram}</p>
        </div>
      </div>
      <div className="rounded-sm border border-line bg-surface p-8">
        <SchedulingForm />
      </div>
    </div>
  );
}
