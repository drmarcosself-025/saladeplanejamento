# Presença cinematográfica

O avatar usa uma imagem sintética transparente em `web/assets/jarvis-live-action.webp`. A superfície tem volume e sombra; a rede orgânica permanece sob o material translúcido.

O renderizador extrai a luz âmbar em uma camada e anima seu fluxo. Essa camada muda conforme o estado determinístico: repouso e fala em âmbar, escuta em azul, processamento em violeta e abertura de ação confirmada em verde. A imagem não recebe dados pessoais e não contém fotografia ou biometria de uma pessoa real.

`tools/build-artifact.mjs` embute a imagem no HTML final. Não há requisição externa para carregar o avatar no artefato. Na versão local, a imagem vem da pasta `web/assets`. A malha procedural permanece como alternativa se o carregamento falhar.

O acabamento é uma imagem com iluminação animada, não um modelo tridimensional articulado. O teste isolado em `tests/avatar-browser.mjs` verifica a imagem carregada e as cinco cores nos pixels renderizados. Só as capturas isoladas do avatar são publicadas pelo teste.

## Toque e órbita (v4)

**Gestos no avatar** (`avatar.js`): arrastar inclina o busto (a energia desloca um pouco mais que o corpo, para dar profundidade) e uma mola o devolve ao centro; pinça, Ctrl/⌘+roda, os botões ou as teclas `+`, `-` e `0` ampliam de 1× a 2,6×; duplo toque amplia ou volta; um toque faz a energia das veias correr a partir do ponto tocado. Com zoom, arrastar move a imagem. Sem toque, o desenho é idêntico ao padrão (o teste de pixels continua valendo). A suavização usa o tempo, não a contagem de quadros. O redimensionamento do canvas só acontece quando o tamanho muda de fato (antes, o primeiro aviso do navegador apagava o desenho).

**Órbita** (`orbita.js`, estilos em `vida.css`): fica ao redor do avatar e só observa `html[data-estado]`; não altera `app.js`. Mostra o estado com cronômetro (raciocinando, ouvindo e falando, com progresso até o fim estimado da fala), seis atalhos com contagem viva (retornos, contas, prioridades, contatos), as medidas do dia (interações, raciocínio médio, última fala, guardadas só neste navegador) e o zoom. A cor da interface acompanha o estado. Em telas ou colunas estreitas (menos de 560 px de avatar) os atalhos viram uma fileira. Os atalhos acionam os controles existentes e **não repetem** `data-command`, `data-open` ou `data-view`, para não duplicar seletores.
