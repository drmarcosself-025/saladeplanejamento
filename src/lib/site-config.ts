// Dados centrais da marca. Os campos marcados com [PREENCHER] são
// placeholders reais que precisam ser substituídos pelo consultório —
// nenhum dado de credencial, endereço ou contato aqui é inventado.
export const siteConfig = {
  fullName: "Dr. Marcos Paulo Araújo",
  shortName: "Dr. Marcos Paulo Araújo",
  role: "Cirurgião-Dentista · Ortodontia & Harmonização Facial",
  cro: "[PREENCHER: CRO-UF 00000]",
  phoneDisplay: "[PREENCHER: (00) 00000-0000]",
  whatsappNumber: "5500000000000", // [PREENCHER] somente dígitos, com DDI 55
  email: "[PREENCHER: contato@drmarcospauloaraujo.com]",
  addressLine: "[PREENCHER: Endereço completo do consultório]",
  city: "[PREENCHER: Cidade]",
  instagram: "[PREENCHER: @drmarcospauloaraujo]",
  domain: "https://www.drmarcospauloaraujo.com",
  stats: {
    years: "7",
    patients: "12.000+",
  },
} as const;

export const navLinks = [
  { href: "/", label: "Início" },
  { href: "/sobre", label: "Sobre" },
  { href: "/harmonizacao-facial", label: "Harmonização Facial" },
  { href: "/ortodontia-invisalign", label: "Ortodontia" },
  { href: "/resultados", label: "Resultados" },
  { href: "/consultorio", label: "Consultório" },
  { href: "/blog", label: "Blog" },
] as const;

export function whatsappHref(message: string) {
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${siteConfig.whatsappNumber}?text=${encoded}`;
}
