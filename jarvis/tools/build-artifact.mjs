// Gera UM arquivo HTML autocontido a partir de web/ (para publicar como
// artefato do claude.ai, onde só se aceita CSS/JS embutidos).
//   node jarvis/tools/build-artifact.mjs <saida.html>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const out = process.argv[2];
if (!out) { console.error("uso: node build-artifact.mjs <saida.html>"); process.exit(1); }

const html = fs.readFileSync(path.join(web, "index.html"), "utf8");
const title = (html.match(/<title>([^<]+)<\/title>/) || [, "Jarvis"])[1];
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]+>/)[0];
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const css = fs.readFileSync(path.join(web, "app.css"), "utf8");
const body = html.split("<body>")[1].split("</body>")[0].replace(/<script src="[^"]+"><\/script>\s*/g, "").trim();

const js = scripts.map((f) => {
  const t = fs.readFileSync(path.join(web, f), "utf8");
  if (/<\/script/i.test(t)) throw new Error(f + " contém </script>");
  return `/* ${f} */\n${t}`;
}).join("\n");

fs.writeFileSync(out, `<title>${title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${css}
</style>
${body}
<script>
${js}
</script>
`);
console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(1)} KB, ${scripts.length} scripts`);
