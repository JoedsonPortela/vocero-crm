# E2E 008 — Paridade do WhatsApp no inbox

Roteiro de comportamento (Constituição IX). A parte automatizada vive na
seção "008" de `scripts/e2e-selftest.mjs` (app com `WA_MOCK_ENABLED=true`,
BD nova, `MEDIA_DIR` local); este documento registra o mapeamento para os AC da
spec e os passos visuais do Playwright.

## US1 — Echoes de coexistência (automatizado)

| AC | Check do selftest |
|---|---|
| AC-1 mensagem manual visível como saída manual | "el mensaje manual aparece como saliente origin=manual" |
| AC-2 IA pausada após resposta manual | "la IA quedó pausada con handoff manual_reply" + "el echo NO tocó la ventana" |
| AC-3 reativação pelo CRM | "reactivar la IA desde el CRM limpia el handoff" |
| AC-4 echo duplicado não duplica | "echo duplicado (mismo wamid) no duplica el mensaje" |
| AC-5 echo com anexo visualizável | "echo con imagen: manual + asset descargado" |
| Borda: conversa nova a partir do telefone | "echo a número nuevo crea contacto y conversación" |
| Borda: payload sob a chave `messages` | "echo bajo la clave `messages` también se ingiere" |

Os textos entre aspas são os rótulos literais dos checks em `scripts/e2e-selftest.mjs`.

## US2 — Envio de anexos (automatizado)

| AC | Check |
|---|---|
| AC-1 imagem + legenda + estados | "imagen con caption enviada (201)" + "asset disponible y origin=operator" + outbox `type=image` |
| AC-2 localização | "ubicación enviada" + payload lat/long + outbox `type=location` |
| AC-3 limite de tamanho ANTES de enviar | "imagen de 6 MB → 413 too_large" |
| AC-4 janela fechada = mesma regra do texto | coberto pelos checks de janela existentes (o pré-voo é compartilhado: `prepareSend`) |
| AC-5 falha do canal → mensagem failed visível | unit `media-send.test.ts` (persistência failed) + sandbox |

## US3 — Prévias de entrada (automatizado)

| AC | Check |
|---|---|
| AC-1 foto ampliável | "imagen entrante queda disponible" + "el binario entrante se sirve" |
| AC-2 nota de voz reproduzível | mesmo pipeline da imagem (kind audio); visual no Playwright |
| AC-3 disponível após expirar na Meta | o binário é servido de `MEDIA_DIR`, não do Graph (a URL do mock só é usada no download) |
| AC-4 conteúdo indisponível degradado | "descarga fallida degrada a failed" + "410 gone" |

## Passos visuais (Playwright, ao fechar a feature)

1. Login → Inbox → conversa "Lead 008": o fio mostra a bolha manual com o
   selo 📱 "Celular", a imagem enviada com miniatura e legenda, a localização
   com link, e o anexo quebrado com "conteúdo indisponível".
2. Compositor: o clipe 📎 abre o seletor; a imagem escolhida mostra prévia com
   nome/tamanho; o texto passa a ser "legenda do anexo".
3. Painel do contato: a conversa pausada mostra "Você respondeu pelo telefone —
   IA em pausa" e o botão de reativar funciona.

## Ao vivo (produção, regras Evolution)

1. Responder pelo app do WhatsApp Business do telefone à conversa da linha de
   testes → aparece como manual no CRM e a IA pausa (testado com uma instância
   real em coexistência).
2. Reativar a IA pelo CRM → o agente volta a responder.
3. Enviar pelo CRM para a linha de testes: imagem com legenda, um PDF e uma
   localização (pausas de ≥8 s; verificar o recebimento no telefone).
4. Da linha de testes enviar foto e nota de voz → prévias no CRM.
