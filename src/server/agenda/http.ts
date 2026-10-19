import { BookingError, type BookingResult } from "@/server/agenda/service";

/**
 * 015 — A tradução entre o domínio e HTTP, em um único lugar.
 *
 * Mora aqui e não dentro dos `route.ts` por duas razões: o Next só admite
 * handlers como exports de uma rota (então não seriam testáveis), e porque
 * os códigos e a FORMA do erro são contrato observável, não um detalhe.
 *
 * As duas lições que custaram caro em produção e que este módulo fixa:
 *  - Criar responde **201**, não 200. Um cliente que validava `=== 200` deixou
 *    todos os leads sem agendar durante horas, e os mocks não viram isso
 *    porque respondiam 200.
 *  - O erro vai ANINHADO (`{"error":{"code":…}}`) com `slots` como IRMÃO. Um
 *    mock com a forma plana escondeu o caminho de re-oferta por semanas:
 *    todo 409 era lido como conflito genérico e as alternativas nunca
 *    eram ofertadas.
 */

export type BookingPayload = {
  bookingId: string;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

export function bookingPayload(result: BookingResult): BookingPayload {
  return {
    bookingId: result.booking.id,
    meetingLink: result.meetingLink,
    /**
     * true ⇒ o agendamento EXISTE, mas o provedor ainda não entregou o link.
     * Confirme o agendamento e diga que o link chega depois; não prometa um que
     * você não tem.
     */
    linkPending: result.linkPending,
    label: result.label,
  };
}

export function bookingErrorStatus(code: BookingError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid":
      return 422;
    case "slot_taken":
    case "slot_not_offered":
      return 409;
  }
}

/** Traduz um `BookingError` para o envelope padrão. Qualquer outro erro é relançado. */
export function bookingErrorResponse(err: unknown): Response {
  if (!(err instanceof BookingError)) throw err;
  const code = err.code === "invalid" ? "invalid_body" : err.code;
  return Response.json(
    { error: { code, message: err.message }, slots: err.slots },
    { status: bookingErrorStatus(err.code) }
  );
}
