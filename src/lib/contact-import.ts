import { normalizeMx } from "@/lib/meta/client";

/**
 * Importação de contatos a partir de um CSV: a parte PURA.
 *
 * Usada pelos dois lados: o diálogo, para mostrar o que será importado antes
 * de enviar nada, e o endpoint, que valida de novo porque não confia no que
 * diz o navegador. Com uma única cópia, o que o dono vê na pré-visualização
 * é exatamente o que o servidor aceita.
 */

export const IMPORT_MAX_ROWS = 2000;

export type ImportRow = { name: string; phone: string };

export type ImportProblem = {
  /** Linha do arquivo, contando o cabeçalho como 1. */
  line: number;
  name: string;
  reason: "sin_telefono" | "sin_codigo_pais" | "telefono_invalido" | "repetido";
};

export const PROBLEM_LABELS: Record<ImportProblem["reason"], string> = {
  sin_telefono: "sin teléfono",
  sin_codigo_pais: "le falta el código de país",
  telefono_invalido: "teléfono inválido",
  repetido: "repetido en el archivo",
};

/**
 * CSV para tabela. Suporta aspas, aspas duplas escapadas, quebras de linha
 * dentro de um campo, e `;` ou tabulação como separador (o Excel em espanhol
 * exporta com `;`).
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"]
    .map((d) => ({ d, n: firstLine.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]!.d;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const PHONE_HEADERS = ["telefono", "phone", "whatsapp", "celular", "movil", "numero", "tel"];
const NAME_HEADERS = ["nombre", "name", "contacto", "first name", "firstname"];
const SURNAME_HEADERS = ["apellido", "apellidos", "last name", "lastname"];

/**
 * Qual coluna é qual, pelo cabeçalho. Devolve null se não houver coluna de
 * telefone: sem ela não há nada a importar, e adivinhá-la pelo conteúdo
 * acabaria importando uma coluna de valores como telefones.
 */
export function detectColumns(
  header: string[]
): { name: number; surname: number | null; phone: number } | null {
  const cols = header.map(plain);
  const find = (candidates: string[]) => {
    const exact = cols.findIndex((c) => candidates.includes(c));
    if (exact >= 0) return exact;
    return cols.findIndex((c) => candidates.some((k) => c.startsWith(k)));
  };
  const phone = find(PHONE_HEADERS);
  const name = find(NAME_HEADERS);
  if (phone < 0 || name < 0 || phone === name) return null;
  const surname = find(SURNAME_HEADERS);
  return { name, surname: surname >= 0 && surname !== name ? surname : null, phone };
}

/**
 * Telefone para identidade do WhatsApp, ou o motivo pelo qual não serve.
 *
 * Exige código do país igual ao cadastro manual: dez dígitos são um número
 * local em vários países, e presumir um produziria um contato que jamais casa
 * com quem escrever depois.
 */
export function normalizeImportPhone(
  raw: string
): { ok: true; phone: string } | { ok: false; reason: ImportProblem["reason"] } {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "sin_telefono" };
  if (digits.length > 15) return { ok: false, reason: "telefono_invalido" };
  if (digits.length < 11) return { ok: false, reason: "sin_codigo_pais" };
  return { ok: true, phone: normalizeMx(digits) };
}

/** Linhas cruas para linhas importáveis + o que ficou de fora e por quê. */
export function prepareImport(rows: { name: string; phone: string }[]): {
  valid: ImportRow[];
  problems: ImportProblem[];
} {
  const valid: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const line = i + 2;
    const name = r.name.replace(/\s+/g, " ").trim().slice(0, 120);
    const res = normalizeImportPhone(r.phone);
    if (!res.ok) {
      problems.push({ line, name, reason: res.reason });
      return;
    }
    if (seen.has(res.phone)) {
      problems.push({ line, name, reason: "repetido" });
      return;
    }
    seen.add(res.phone);
    // Sem nome importa igual, com o telefone como nome: é o mesmo
    // que faz a ingestão quando alguém escreve sem nome de perfil.
    valid.push({ name: name || res.phone, phone: res.phone });
  });
  return { valid, problems };
}

/** Do texto do arquivo para linhas prontas, ou o motivo pelo qual não pôde ser lido. */
export function readImportFile(
  text: string
):
  | { ok: true; valid: ImportRow[]; problems: ImportProblem[]; total: number }
  | { ok: false; error: string } {
  const table = parseCsv(text);
  if (table.length < 2) {
    return { ok: false, error: "O arquivo está vazio ou traz apenas o cabeçalho." };
  }
  const cols = detectColumns(table[0]!);
  if (!cols) {
    return {
      ok: false,
      error:
        "No encontré las columnas. El archivo necesita una columna «nombre» y una «telefono» en el primer renglón.",
    };
  }
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS) {
    return {
      ok: false,
      error: `El archivo trae ${body.length} renglones; el máximo por importación es ${IMPORT_MAX_ROWS}.`,
    };
  }
  const rows = body.map((r) => ({
    name: [r[cols.name], cols.surname !== null ? r[cols.surname] : ""]
      .map((v) => (v ?? "").trim())
      .filter(Boolean)
      .join(" "),
    phone: r[cols.phone] ?? "",
  }));
  return { ok: true, ...prepareImport(rows), total: body.length };
}
