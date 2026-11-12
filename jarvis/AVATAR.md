# Presença cinematográfica

O avatar usa uma imagem sintética transparente em `web/assets/jarvis-live-action.webp`. A superfície tem volume e sombra; a rede orgânica permanece sob o material translúcido.

O renderizador extrai a luz âmbar em uma camada e anima seu fluxo. Essa camada muda conforme o estado determinístico: repouso e fala em âmbar, escuta em azul, processamento em violeta e abertura de ação confirmada em verde. A imagem não recebe dados pessoais e não contém fotografia ou biometria de uma pessoa real.

`tools/build-artifact.mjs` embute a imagem no HTML final. Não há requisição externa para carregar o avatar no artefato. Na versão local, a imagem vem da pasta `web/assets`. A malha procedural permanece como alternativa se o carregamento falhar.

O acabamento é uma imagem com iluminação animada, não um modelo tridimensional articulado. O teste isolado em `tests/avatar-browser.mjs` verifica a imagem carregada e as cinco cores nos pixels renderizados. Só as capturas isoladas do avatar são publicadas pelo teste.
