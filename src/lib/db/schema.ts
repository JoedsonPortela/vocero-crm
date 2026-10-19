import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Tempo: todas as colunas são `timestamp without time zone` e o marco é
 * UTC. O Drizzle respeita nas duas direções; o `now()` dos `defaultNow()`
 * só respeita porque a conexão fixa `TimeZone: "UTC"`
 * (ver src/lib/db/index.ts). Não mude uma coluna para `timestamptz` isoladamente:
 * ao lê-la o Drizzle continuaria acrescentando "+0000", a menos que também
 * leve `{ withTimezone: true }`.
 */

/* ============================================================
 * Auth (Better Auth + plugin organization)
 * ============================================================ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  metadata: text("metadata"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/* ============================================================
 * Domínio (toda tabela leva organization_id NOT NULL + índice org-first)
 * ============================================================ */

export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Chave de resolução do WhatsApp (003): telefone normalizado (521→52) ou
     * `bsuid:<id>` quando a Meta não envia wa_id. Estável para sempre.
     */
    /**
     * 014: canal pelo qual este contato vive. Aditivo e com padrão: toda
     * linha existente continua significando exatamente o mesmo.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger", "tiktok"] })
      .notNull()
      .default("whatsapp"),
    /**
     * Chave de resolução. WhatsApp: telefone normalizado (521 para 52) ou
     * `bsuid:<id>`. Instagram (014): `ig:<IGSID>`. Estável para sempre.
     * O nome `wa_identity` é mantido porque é contrato publicado:
     * `/api/bot/context?waIdentity=...` o recebe e o devolve, e há
     * cérebros externos que dependem dele.
     */
    waIdentity: text("wa_identity").notNull(),
    /** Telefone como ATRIBUTO opcional (003): falta em contatos BSUID. */
    phone: text("phone"),
    /** Business-Scoped User ID, se conhecido (003). */
    waUserId: text("wa_user_id"),
    name: text("name").notNull(),
    /**
     * Quem colocou este nome.
     *
     * `perfil` = veio do WhatsApp e pode continuar sendo atualizado sozinho;
     * `manual` = foi escrito por uma pessoa no CRM e NINGUÉM o sobrescreve.
     *
     * Existe porque as duas coisas são necessárias ao mesmo tempo: um contato que
     * muda o nome do WhatsApp precisa ser refletido (#51), e o operador
     * que renomeou alguém para "Juan - obra Polanco" não pode perder esse
     * trabalho com a próxima mensagem.
     */
    nameSource: text("name_source", { enum: ["perfil", "manual"] })
      .notNull()
      .default("perfil"),
    notes: text("notes"),
    /**
     * Ficha de qualificação levantada por um cérebro externo via
     * `PUT /api/bot/ficha`. É um objeto livre de propósito: os dados que
     * importam de um lead são definidos por cada negócio (uma clínica vai querer
     * "tratamento", uma construtora "metros"), e cabeá-los como colunas
     * obrigaria a migrar o CRM toda vez que alguém muda o seu questionário.
     * Merge campo a campo; `null` explícito apaga a chave.
     */
    ficha: jsonb("ficha").$type<Record<string, unknown>>(),
    /**
     * De onde saiu o prospect. NULL = ninguém o capturou, e então a API
     * o deduz. Assim não é preciso backfill nem marcar falsamente os contatos
     * que já existiam.
     */
    source: text("source", {
      enum: ["anuncio", "organico", "referido", "conocido", "otro"],
    }),
    /**
     * 027 — O agente não responde a esta pessoa: clientes, membros,
     * fornecedores — gente a quem o dono quer atender pessoalmente.
     *
     * Vive no CONTATO e não só na conversa porque um contato
     * importado ainda não tem conversa (não se criam fios vazios), e
     * porque ao excluir uma conversa (026) a seguinte nasceria com o
     * agente ligado. A conversa o herda ao ser criada
     * (`getOrCreateConversation`); depois prevalece o interruptor da Bandeja.
     */
    aiPaused: boolean("ai_paused").notNull().default(false),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // 014: o canal entra na chave. Sem ele, um IGSID que coincidisse com
    // um telefone normalizado misturaria duas pessoas em silêncio.
    uniqueIndex("contact_org_channel_identity_uq").on(
      t.organizationId,
      t.channel,
      t.waIdentity
    ),
    index("contact_org_wa_user_id_idx").on(t.organizationId, t.waUserId),
    index("contact_org_name_idx").on(t.organizationId, t.name),
  ]
);

export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** open = etapa normal · won / lost = âncoras não apagáveis */
    kind: text("kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("stage_org_pos_idx").on(t.organizationId, t.position)]
);

export const lead = pgTable(
  "lead",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    stageId: text("stage_id")
      .notNull()
      .references(() => pipelineStage.id),
    position: integer("position").notNull().default(0),
    /**
     * Valor da negociação em CENTAVOS INTEIROS. NULL = ninguém o capturou, o que
     * não é o mesmo que zero: um negócio sem valor não vale $0, simplesmente não se
     * sabe, e o painel diz isso com palavras em vez de somar um zero.
     */
    amountCents: integer("amount_cents"),
    /** Moeda do valor; a do negócio no momento do registro (Ajustes → Marca). */
    currency: text("currency"),
    /**
     * Prioridade de fechamento. NULL = ninguém a decidiu, o que NÃO é o mesmo que
     * "média": nada a escreve automaticamente, então o dono pode confiar
     * que o que vê é o que ele colocou.
     */
    priority: text("priority", { enum: ["alta", "media", "baja"] }),
    priorityUpdatedAt: timestamp("priority_updated_at"),
    lastActivityAt: timestamp("last_activity_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_contact_uq").on(t.contactId),
    index("lead_org_stage_idx").on(t.organizationId, t.stageId, t.position),
  ]
);

/**
 * Registro de movimentações de etapa: somente anexar. Nada é atualizado nem apagado;
 * corrigir um dado é adicionar um movimento novo.
 *
 * É a base de todo o histórico: sem ele o CRM só sabe onde está
 * cada lead HOJE, e "quanto fechei em julho?" não tem resposta.
 *
 * Regra dura: a ÚNICA porta que escreve aqui — e que escreve `lead.stage_id` —
 * é `src/server/leads/stage-history.ts`. Um teste unitário de vigilância falha se
 * aparecer outra escrita, porque um caminho que mova o lead sem registrar o
 * evento não estoura erro: só faz os gráficos mentirem meses depois.
 */
export const leadStageEvent = pgTable(
  "lead_stage_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    /** Desnormalizado de propósito: quase toda agregação cruza com o contato,
     *  e o join extra seria pago em cada consulta. */
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** NULL = o lead nasceu em `toStage` (evento de criação). */
    fromStageId: text("from_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    fromStageName: text("from_stage_name"),
    toStageId: text("to_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    /** Snapshots: sobrevivem à renomeação e à exclusão da etapa, para que
     *  reorganizar o painel de hoje não reescreva o funil do passado. */
    toStageName: text("to_stage_name").notNull(),
    toStageKind: text("to_stage_kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    /** Quando PASSOU (não quando foi registrado). */
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    /** NULL = não foi movido por uma pessoa (bot, sistema, migração). */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source", {
      enum: ["dueno", "bot", "sistema", "migracion"],
    })
      .notNull()
      .default("dueno"),
    /** true = data SEMEADA na migração, não observada. Conta para os
     *  totais, mas jamais para médias de tempo. */
    approximate: boolean("approximate").notNull().default(false),
    lossReason: text("loss_reason", {
      enum: [
        "precio",
        "no_es_perfil",
        "sin_presupuesto",
        "eligio_otro",
        "nunca_contesto",
        "otro",
      ],
    }),
    lossNote: text("loss_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("lse_org_occurred_idx").on(t.organizationId, t.occurredAt),
    index("lse_lead_occurred_idx").on(t.leadId, t.occurredAt),
    index("lse_org_kind_occurred_idx").on(
      t.organizationId,
      t.toStageKind,
      t.occurredAt
    ),
    // Perder um negócio sem motivo é impossível em nível de BASE, não por
    // disciplina de cada rota. A exceção é a semeadura da migração: não
    // pode inventar um motivo que ninguém capturou.
    check(
      "lse_loss_reason_ck",
      sql`${t.toStageKind} <> 'lost' OR ${t.approximate} = true OR ${t.lossReason} IS NOT NULL`
    ),
  ]
);

export const conversation = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Conversa do Laboratório: jamais toca a API do WhatsApp. */
    isTest: boolean("is_test").notNull().default(false),
    /**
     * 014: canal da conversa. Desnormalizado do contato de propósito:
     * o roteamento de saída e o filtro da bandeja o leem em cada mensagem.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger", "tiktok"] })
      .notNull()
      .default("whatsapp"),
    /**
     * 014: identificador do fio na plataforma de origem. O Zernio entrega
     * um conversationId opaco ("não assuma o formato dele") que é necessário para
     * responder; o WhatsApp não precisa dele e fica null.
     */
    channelThreadRef: text("channel_thread_ref"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    handoffAt: timestamp("handoff_at"),
    handoffReason: text("handoff_reason", {
      // 008: manual_reply = o dono respondeu pelo aplicativo do telefone.
      // hostilidade = o lead ficou agressivo e o agente se retirou.
      enum: [
        "cliente",
        "modelo",
        "error",
        "ventana",
        "hostilidad",
        "manual_reply",
      ],
    }),
    lastInboundAt: timestamp("last_inbound_at"),
    lastMessageAt: timestamp("last_message_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Uma conversa real por contato; as de teste não competem.
    uniqueIndex("conversation_org_contact_real_uq")
      .on(t.organizationId, t.contactId)
      .where(sql`${t.isTest} = false`),
    index("conversation_org_last_idx").on(t.organizationId, t.lastMessageAt),
  ]
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** ID do WhatsApp — UNIQUE (idempotência). Anulável em saídas de teste. */
    waMessageId: text("wa_message_id").unique(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    type: text("type").notNull().default("text"),
    text: text("text"),
    status: text("status", {
      enum: ["pending", "sent", "delivered", "read", "failed"],
    })
      .notNull()
      .default("pending"),
    error: text("error"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /**
     * 008 — Origem da saída: IA (bot), operador do CRM, manual pelo
     * aplicativo do WhatsApp Business do telefone (echo), ou modelo. Nas entradas
     * fica o padrão e a UI o ignora.
     */
    origin: text("origin", {
      enum: ["ai", "operator", "manual", "template"],
    })
      .notNull()
      .default("operator"),
    /** 008 — Anexo da mensagem (imagem, doc, localização…), se houver. */
    mediaAssetId: text("media_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    waTimestamp: timestamp("wa_timestamp"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("message_org_conv_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt
    ),
  ]
);

/**
 * 008 — Anexos: arquivo (imagem/vídeo/áudio/documento/sticker) copiado para o
 * volume local (`MEDIA_DIR`) ou conteúdo estruturado (location/contacts) em
 * `payload`. A Meta expira os seus arquivos (~30 dias): o disco próprio é a
 * fonte durável (constituição II: sem S3/R2).
 */
export const mediaAsset = pgTable(
  "media_asset",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
        "contacts",
      ],
    }).notNull(),
    /** id de mídia do Graph (entradas/saídas enviadas); NULL em location/contacts. */
    waMediaId: text("wa_media_id"),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    caption: text("caption"),
    /** location {latitude, longitude, name?, address?} ou contacts (subconjunto). */
    payload: jsonb("payload"),
    /** Caminho relativo dentro de MEDIA_DIR; NULL se ainda não baixado ou não se aplica. */
    storagePath: text("storage_path"),
    fetchStatus: text("fetch_status", {
      enum: ["available", "pending", "failed"],
    })
      .notNull()
      .default("pending"),
    fetchError: text("fetch_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("media_asset_org_idx").on(t.organizationId, t.createdAt),
    index("media_asset_wa_media_idx").on(t.waMediaId),
  ]
);

export const metaCredentials = pgTable(
  "meta_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    wabaId: text("waba_id").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    displayPhoneNumber: text("display_phone_number"),
    verifiedName: text("verified_name"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_credentials_org_uq").on(t.organizationId),
    // O webhook roteia por phone_number_id: deve ser único na instância.
    uniqueIndex("meta_credentials_phone_uq").on(t.phoneNumberId),
  ]
);

/**
 * 014 - Credenciais do canal do Instagram. Tabela explícita (não um jsonb
 * genérico) porque credenciais têm forma fixa e conhecida: assim
 * mantêm tipagem e índices. O token é cifrado com os mesmos helpers que o
 * do WhatsApp; um segundo mecanismo de cifragem seria um segundo mecanismo para
 * auditar.
 */
export const instagramCredentials = pgTable(
  "instagram_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De onde vêm as mensagens: API unificada ou app próprio da Meta. */
    source: text("source", { enum: ["zernio", "meta"] }).notNull(),
    /** IG_ID do perfil profissional: é por ele que o webhook roteia. */
    igUserId: text("ig_user_id").notNull(),
    /** Zernio: accountId da conta conectada. Meta direto: null. */
    accountRef: text("account_ref"),
    username: text("username"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * 030 — Obsoleta: o segredo ia em texto claro. Nada a escreve; a inicialização
     * a cifra nas colunas abaixo e a deixa nula. É removida em uma
     * versão maior (spec 030, D6).
     */
    webhookSecret: text("webhook_secret"),
    /** 030 — Segredo HMAC das entregas do Zernio, cifrado como o token. */
    webhookSecretCipher: text("webhook_secret_cipher"),
    webhookSecretIv: text("webhook_secret_iv"),
    webhookSecretTag: text("webhook_secret_tag"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instagram_credentials_org_uq").on(t.organizationId),
    uniqueIndex("instagram_credentials_ig_user_uq").on(t.igUserId),
    index("instagram_credentials_account_ref_idx").on(t.accountRef),
  ]
);

/**
 * 017 — Credenciais do canal do Messenger: a página do Facebook e seu token
 * de acesso, cifrado com o mesmo AES-256-GCM dos demais. Tabela própria e
 * explícita, como a do Instagram: credenciais têm forma fixa e
 * conhecida, e escondê-las num jsonb perderia a tipagem e os índices.
 */
export const messengerCredentials = pgTable(
  "messenger_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De onde vêm as mensagens: API unificada ou app próprio da Meta. */
    source: text("source", { enum: ["zernio", "meta"] })
      .notNull()
      .default("meta"),
    /**
     * ID da página do Facebook: é por ele que o webhook da Meta roteia
     * (`entry[].id`). No modo Zernio pode não ser conhecido — aí roteia
     * `account_ref` — então é opcional.
     */
    pageId: text("page_id"),
    pageName: text("page_name"),
    /** Zernio: accountId da conta conectada. Meta direto: null. */
    accountRef: text("account_ref"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * 030 — Obsoleta: o segredo ia em texto claro. Nada a escreve; a inicialização
     * a cifra nas colunas abaixo e a deixa nula. É removida em uma
     * versão maior (spec 030, D6).
     */
    webhookSecret: text("webhook_secret"),
    /** 030 — Segredo HMAC das entregas do Zernio, cifrado como o token. */
    webhookSecretCipher: text("webhook_secret_cipher"),
    webhookSecretIv: text("webhook_secret_iv"),
    webhookSecretTag: text("webhook_secret_tag"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messenger_credentials_org_uq").on(t.organizationId),
    uniqueIndex("messenger_credentials_page_uq").on(t.pageId),
    index("messenger_credentials_account_ref_idx").on(t.accountRef),
  ]
);

/**
 * 022 — Credenciais do canal do TikTok.
 *
 * O TikTok não abre a sua API de mensagens a um app próprio como faz a Meta: chega pela
 * API unificada do Zernio. `source` existe, com um único valor, para que uma
 * fonte futura não exija outra migração (mesmo padrão de
 * `messenger_credentials`).
 */
export const tiktokCredentials = pgTable(
  "tiktok_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["zernio"] }).notNull().default("zernio"),
    /** `accountId` da conta no Zernio: é por ele que o webhook roteia. */
    accountRef: text("account_ref").notNull(),
    /** Usuário do TikTok, só para exibi-lo em Ajustes. */
    username: text("username"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * 030 — Obsoleta: o segredo ia em texto claro. Nada a escreve; a inicialização
     * a cifra nas colunas abaixo e a deixa nula. É removida em uma
     * versão maior (spec 030, D6).
     */
    webhookSecret: text("webhook_secret"),
    /** 030 — Segredo HMAC das entregas do Zernio, cifrado como o token. */
    webhookSecretCipher: text("webhook_secret_cipher"),
    webhookSecretIv: text("webhook_secret_iv"),
    webhookSecretTag: text("webhook_secret_tag"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tiktok_credentials_org_uq").on(t.organizationId),
    uniqueIndex("tiktok_credentials_account_ref_uq").on(t.accountRef),
  ]
);

export const agentProfile = pgTable(
  "agent_profile",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    name: text("name").notNull().default("Asistente"),
    tone: text("tone"),
    instructions: text("instructions"),
    escalationRules: text("escalation_rules"),
    greeting: text("greeting"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_profile_org_uq").on(t.organizationId)]
);

export const kbEntry = pgTable(
  "kb_entry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["qa", "block"] }).notNull(),
    question: text("question"),
    answer: text("answer"),
    content: text("content"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("kb_org_idx").on(t.organizationId)]
);

export const template = pgTable(
  "template",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    body: text("body").notNull(),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected"],
    })
      .notNull()
      .default("draft"),
    rejectionReason: text("rejection_reason"),
    waTemplateId: text("wa_template_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_org_name_lang_uq").on(
      t.organizationId,
      t.name,
      t.language
    ),
  ]
);

export const agentTestRun = pgTable(
  "agent_test_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "done", "failed"] })
      .notNull()
      .default("running"),
    score: integer("score"),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // Trava de concorrência no BD: no máximo 1 execução ativa por organização.
    uniqueIndex("test_run_org_running_uq")
      .on(t.organizationId)
      .where(sql`${t.status} = 'running'`),
    index("test_run_org_idx").on(t.organizationId, t.startedAt),
  ]
);

/* ============================================================
 * 015 — Motor de agenda (atrás da flag AGENDA)
 *
 * As tabelas são SEMPRE criadas, ligada ou desligada a flag: uma tabela
 * vazia é inerte, e em troca todas as instâncias do mundo compartilham a
 * mesma estrutura e a mesma cadeia de migrações (ADR-001).
 * ============================================================ */

/** Configuração da agenda do negócio: uma linha por organização. */
export const calendarSettings = pgTable(
  "calendar_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `{"mon":[{"start":"09:00","end":"18:00"}]}` — hora de PAREDE, não UTC. */
    weeklyHours: jsonb("weekly_hours").notNull(),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    minNoticeHours: integer("min_notice_hours").notNull().default(2),
    maxDaysAhead: integer("max_days_ahead").notNull().default(7),
    timezone: text("timezone").notNull().default("America/Mexico_City"),
    /**
     * Como a reunião é entregue. `enlace-fijo` não fala com ninguém: é o
     * padrão e a razão de ligar a agenda não exigir terceiros.
     * Um fork adiciona o seu ao catálogo do código sem tocar nesta coluna.
     */
    connector: text("connector").notNull().default("enlace-fijo"),
    /** Sala fixa do conector `enlace-fijo`; null ⇒ agendamentos sem link. */
    meetingLink: text("meeting_link"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_settings_org_uq").on(t.organizationId)]
);

/**
 * O agendamento. Uma só tabela para sessões e bloqueios manuais: um bloqueio é
 * um agendamento sem contato que ocupa a agenda do mesmo jeito.
 */
export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["session", "block"] })
      .notNull()
      .default("session"),
    status: text("status", {
      enum: ["agendada", "realizada", "no_show", "cancelada"],
    })
      .notNull()
      .default("agendada"),
    source: text("source", { enum: ["manual", "ai"] })
      .notNull()
      .default("manual"),
    contactId: text("contact_id").references(() => contact.id, {
      onDelete: "cascade",
    }),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    leadId: text("lead_id").references(() => lead.id, { onDelete: "set null" }),
    /** Instante UTC. O horário semanal é de parede; isto já está resolvido. */
    scheduledAt: timestamp("scheduled_at").notNull(),
    /** Capturada ao criar: mudar a configuração não reescreve o passado. */
    durationMinutes: integer("duration_minutes").notNull(),
    /**
     * Com qual conector nasceu a ENTREGA. Reagendar e cancelar falam com
     * ESTE, não com o ativo: se o negócio trocar de provedor, os agendamentos já
     * confirmados continuam vivendo onde foram criados.
     */
    connector: text("connector"),
    /** Id da reunião/evento no provedor; null em `enlace-fijo`. */
    externalRef: text("external_ref"),
    /**
     * O link que foi dado ao cliente. É COPIADO, não lido da
     * configuração: o agendamento é um fato histórico, não uma visão do presente.
     */
    meetingLink: text("meeting_link"),
    /**
     * O provedor falhou ao criar a reunião. O agendamento existe mesmo assim — um terceiro
     * fora do ar não custa a conversão — e o operador reenvia a partir de "Agendamentos".
     */
    linkPending: boolean("link_pending").notNull().default(false),
    /** Conversa do Laboratório: jamais chama um conector real. */
    isTest: boolean("is_test").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_org_when_idx").on(t.organizationId, t.scheduledAt),
    index("booking_org_status_idx").on(t.organizationId, t.status),
    /**
     * Anti double-booking ATÔMICO. A revalidação na confirmação deixa uma
     * janela entre ler e escrever; isto a fecha no BANCO: duas
     * confirmações simultâneas do mesmo instante não podem vencer as duas, e
     * a perdedora recebe um 23505 que o serviço traduz para `slot_taken` com
     * alternativas novas. Os agendamentos de teste ficam de fora: não consomem a
     * agenda real.
     */
    uniqueIndex("booking_org_active_slot_uq")
      .on(t.organizationId, t.scheduledAt)
      .where(
        sql`${t.status} in ('agendada','realizada') and ${t.isTest} = false`
      ),
  ]
);

/**
 * A memória do que foi ofertado. É o que torna verificável o requisito
 * inegociável: sem linha aqui, não há reserva.
 *
 * Vive no CRM e não em quem conduz a conversa porque o Vocero promete
 * "conecta SEU próprio cérebro": com a garantia do lado do cliente, qualquer
 * cérebro poderia reservar um instante que jamais foi ofertado e o CRM
 * aceitaria.
 */
export const offeredSlot = pgTable(
  "offered_slot",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    startUtc: timestamp("start_utc").notNull(),
    /** O rótulo EXATO que foi mostrado ao cliente. */
    label: text("label").notNull(),
    offeredAt: timestamp("offered_at").notNull().defaultNow(),
  },
  (t) => [index("offered_slot_conv_idx").on(t.conversationId, t.startUtc)]
);

/**
 * Credenciais do conector Zoom (app Server-to-Server do próprio negócio).
 * Tabela explícita como as do WhatsApp e do Instagram: credenciais têm
 * forma fixa e conhecida, e assim mantêm tipagem e índices. O segredo é cifrado
 * com os mesmos helpers; um segundo mecanismo seria mais um para auditar.
 */
export const zoomCredentials = pgTable(
  "zoom_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    clientId: text("client_id").notNull(),
    secretCipher: text("secret_cipher").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    /** `error` É ESCRITO quando o provedor recusa a autenticação. */
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zoom_credentials_org_uq").on(t.organizationId)]
);

/**
 * Credenciais do conector Google (Calendar + Meet), do app do Google
 * Cloud do próprio negócio. DOIS segredos cifrados: o client secret e o
 * refresh token colado uma única vez.
 */
export const googleCredentials = pgTable(
  "google_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientSecretCipher: text("client_secret_cipher").notNull(),
    clientSecretIv: text("client_secret_iv").notNull(),
    clientSecretTag: text("client_secret_tag").notNull(),
    refreshTokenCipher: text("refresh_token_cipher").notNull(),
    refreshTokenIv: text("refresh_token_iv").notNull(),
    refreshTokenTag: text("refresh_token_tag").notNull(),
    calendarId: text("calendar_id").notNull().default("primary"),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("google_credentials_org_uq").on(t.organizationId)]
);

export const agentTestCase = pgTable(
  "agent_test_case",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentTestRun.id, { onDelete: "cascade" }),
    persona: text("persona").notNull(),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    transcript: jsonb("transcript"),
    veredicto: text("veredicto", { enum: ["verde", "amarillo", "rojo"] }),
    hallazgos: jsonb("hallazgos"),
    status: text("status", {
      enum: ["pending", "running", "done", "judge_failed"],
    })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("test_case_run_idx").on(t.runId)]
);

/* ============================================================
 * 016 — Atribuição de anúncios e Conversions API
 * (atrás da flag ATRIBUCION)
 * ============================================================ */

/**
 * De qual anúncio veio uma conversa. O primeiro referral vence: o UNIQUE abaixo
 * é o que torna idempotente a captura diante das novas tentativas da Meta,
 * em vez de um "consulta e depois insere" que dois webhooks simultâneos
 * venceriam os dois.
 */
export const adAttribution = pgTable(
  "ad_attribution",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /**
     * O identificador do clique no anúncio. É a chave de TUDO: sem ele
     * não há nada a reportar à Meta. Anulável porque há referrals sem clid,
     * e porque sem a flag ATRIBUCION não é guardado (018): a origem do
     * anúncio aparece sempre, o identificador de clique só se houver atribuição.
     */
    ctwaClid: text("ctwa_clid"),
    sourceId: text("source_id"),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    headline: text("headline"),
    body: text("body"),
    mediaType: text("media_type"),
    /**
     * 018 — A imagem do criativo, copiada do CDN da Meta (sua URL expira em
     * dias). Compartilhada por todas as conversas do mesmo `source_id`: é
     * baixada uma vez por anúncio. Apagar o anexo deixa a linha sem imagem,
     * não apontando para nada.
     */
    imageAssetId: text("image_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    /**
     * O referral reduzido às suas chaves conhecidas (018: com limites de tamanho,
     * e sem `ctwa_clid` se a flag estava desligada). É a apólice contra
     * "a Meta acrescentou um campo", e daqui se relê a URL da imagem
     * quando é preciso reparar a cópia.
     */
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_attribution_org_conversation_uq").on(
      t.organizationId,
      t.conversationId
    ),
    index("ad_attribution_org_contact_idx").on(t.organizationId, t.contactId),
    // 018 — a imagem já salva de um anúncio, e a quais linhas atribuí-la.
    index("ad_attribution_org_source_idx").on(t.organizationId, t.sourceId),
  ]
);

/**
 * Cada tentativa de reportar um desfecho à Meta. As linhas `skipped` não são
 * lixo: são a resposta a "por que este lead não aparece na Meta?", que sem
 * elas só se responde adivinhando.
 */
export const conversionEvent = pgTable(
  "conversion_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    attributionId: text("attribution_id").references(() => adAttribution.id, {
      onDelete: "set null",
    }),
    /** Nome do catálogo da Meta tal como é (`QualifiedLead`, `Purchase`). */
    eventName: text("event_name").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    /** Motivo legível: por que foi omitido, ou o que a Meta respondeu. */
    error: text("error"),
    /**
     * Confirmação do envio. É a única referência que a Meta pede para rastrear um
     * evento do lado dela; sem persisti-la, um `sent` não pode ser reclamado.
     */
    fbTraceId: text("fb_trace_id"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // A deduplicação É este índice: a linha é inserida ANTES de falar com a Meta
    // com ON CONFLICT DO NOTHING. Dois movimentos simultâneos do mesmo lead
    // não podem mandar duas compras.
    uniqueIndex("conversion_event_org_conv_name_uq").on(
      t.organizationId,
      t.conversationId,
      t.eventName
    ),
    index("conversion_event_org_created_idx").on(
      t.organizationId,
      t.createdAt
    ),
  ]
);

/** Conexão do negócio com o seu dataset da Meta (token cifrado em repouso). */
export const capiSettings = pgTable(
  "capi_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * Qual etapa significa "lead qualificado" PARA ESTE NEGÓCIO. As etapas
     * semeadas do Vocero não incluem nenhuma com esse nome e cada um
     * renomeia as suas, então é escolhida em vez de adivinhada. NULL = esse
     * evento não é emitido. `set null` de propósito: apagar a etapa desliga o
     * evento, não quebra a configuração.
     */
    qualifiedStageId: text("qualified_stage_id").references(
      () => pipelineStage.id,
      { onDelete: "set null" }
    ),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("capi_settings_org_uq").on(t.organizationId)]
);

/* ============================================================
 * Provedor de IA (Ajustes → IA)
 * ============================================================ */

/**
 * Credencial do provedor de IA da organização (porta de `ai_credentials`
 * do Vocero Cloud, issue #85). Uma linha por organização: provedor (sua
 * `base_url` compatível com OpenAI), modelo e token cifrado com os mesmos helpers
 * que o do WhatsApp; para fora só vai `token_last4`.
 *
 * `status` é escrito pelo adaptador conforme o que respondeu QUEM COBRA: 401 →
 * `paused_invalid_token`, 402 → `paused_no_credit`. Um 429 ou um 500 não pausam
 * (ver `server/ai/credentials.ts`). Salvar um token novo volta para `active`.
 *
 * Sem linha, o adaptador cai nas variáveis `OPENROUTER_*` do ambiente
 * (reserva para instalações automatizadas); com linha, a linha prevalece.
 */
export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Predefinição da UI; `base_url` é o que de fato identifica o provedor. */
    provider: text("provider", { enum: ["openrouter", "openai_compatible"] })
      .notNull()
      .default("openrouter"),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /** O ÚNICO trecho do token que pode sair para o cliente. */
    tokenLast4: text("token_last4").notNull(),
    status: text("status", {
      enum: ["active", "paused_invalid_token", "paused_no_credit"],
    })
      .notNull()
      .default("active"),
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_credentials_org_uq").on(t.organizationId)]
);

/* ============================================================
 * 021 — Despacho ao cérebro
 * ============================================================ */

/**
 * A fila de saída do despachador (spec 021): os turnos que o CRM empurra para um
 * cérebro externo. A mensagem já está em `message` antes de existir uma
 * linha aqui: caixa de entrada primeiro, cérebro depois.
 *
 * Mesma tabela, colunas e estados que o `dispatch` do Vocero Cloud, sem o que
 * lá é da plataforma (`brain_generation`, `expires_at`, `brain_kind`,
 * `responded_message_id`).
 */
export const dispatch = pgTable(
  "dispatch",
  {
    /** É o `dispatchId` que viaja ao cérebro: a chave de idempotência. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: [
        "pendiente",
        "en_vuelo",
        "entregado",
        "caducado_a_humano",
        "descartado",
      ],
    })
      .notNull()
      .default("pendiente"),
    /** Sobe ao pegar a linha: distingue dois donos de um mesmo lease. */
    attempts: integer("attempts").notNull().default(0),
    /**
     * A janela de agrupamento: cada mensagem nova da conversa a empurra
     * para a frente. O worker só pega linhas cujo `not_before` já venceu,
     * então uma rajada se junta sozinha.
     */
    notBefore: timestamp("not_before").notNull().defaultNow(),
    firstMessageAt: timestamp("first_message_at").notNull(),
    lastMessageAt: timestamp("last_message_at").notNull(),
    leasedUntil: timestamp("leased_until"),
    /**
     * 025 — As entradas que este despacho DEVE ao cérebro: as que o
     * enfileiraram ou o estenderam.
     *
     * A rajada é delimitada pela última saída, e isso confunde «sem
     * responder» com «sem entregar»: o que o cliente escreve enquanto o
     * cérebro pensa fica ATRÁS da sua resposta. Com os ids anotados, essa
     * mensagem viaja mesmo que já exista uma resposta depois dela. Nulo em linhas
     * anteriores a esta coluna, que se comportam como antes.
     */
    messageIds: jsonb("message_ids").$type<string[]>(),
    /** Motivo da última falha. Nunca o corpo assinado nem a chave. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    /**
     * A peça central desta tabela: no máximo UM despacho vivo por
     * conversa. Daqui saem o agrupamento de rajadas e a ordem, e elas
     * sobrevivem a alguém reescrever o worker, porque a garantia vem do
     * Postgres e não da lógica.
     */
    uniqueIndex("dispatch_conversation_vivo_uq")
      .on(t.conversationId)
      .where(sql`${t.status} in ('pendiente', 'en_vuelo')`),
    /**
     * O cartão «Quem responde» pergunta pelo último entregue e o último
     * falho. Com `updated_at` no índice essa pergunta custa o mesmo com
     * cem linhas ou com um milhão; sem ele, cada atualização ordenava todo o
     * histórico. (No Vocero Cloud é `dispatch_org_status_idx`, sem a terceira
     * coluna: este é o seu superconjunto.)
     */
    index("dispatch_org_status_updated_idx").on(
      t.organizationId,
      t.status,
      t.updatedAt
    ),
    // A consulta do worker: pendentes cuja janela já venceu.
    index("dispatch_status_notbefore_idx").on(t.status, t.notBefore),
  ]
);
