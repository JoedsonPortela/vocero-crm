/**
 * Traduz o erro de envio da Meta para algo que o operador possa ACIONAR.
 *
 * A Meta envia o motivo em inglês e em jargão próprio ("User's number is part of
 * an experiment"), e o CRM o guardava sem mostrá-lo: a mensagem falha só
 * exibia um triângulo mudo. Aqui é convertido em uma frase que diz o que
 * aconteceu e o que fazer, mantendo o código para poder rastreá-lo na
 * documentação da Meta.
 */

const DESCRIPTIONS: Record<number, string> = {
  130472:
    "Meta tiene el número del destinatario en un experimento y le está bloqueando los mensajes de MARKETING. No es un fallo de tu configuración: prueba con una plantilla de categoría UTILITY o con otro número.",
  131049:
    "Meta limitó los mensajes de marketing hacia este usuario para cuidar la calidad del ecosistema. Espera o usa una plantilla de categoría UTILITY.",
  131047:
    "Pasaron más de 24 h desde el último mensaje del cliente: solo se puede reabrir con una plantilla aprobada.",
  131048:
    "Meta frenó el envío por límite de spam en tu número. Baja el ritmo de envíos y revisa la calidad del número.",
  131026:
    "El destinatario no puede recibir mensajes de WhatsApp (número inexistente, sin cuenta o que no acepta mensajes de empresas).",
  131031:
    "Tu cuenta de WhatsApp Business está bloqueada o restringida por Meta. Revísalo en el Administrador de WhatsApp.",
  131030:
    "El número del destinatario no está en la lista de permitidos de tu app en modo de prueba.",
  130429:
    "Superaste el límite de mensajes por segundo de Meta. Reintenta en unos momentos.",
  132000:
    "La plantilla y los parámetros enviados no coinciden (faltan o sobran variables).",
  132001:
    "Meta no encuentra esa plantilla con ese idioma. Sincroniza las plantillas y confirma que sigue aprobada.",
  132005:
    "El texto traducido de la plantilla supera el límite de caracteres de Meta.",
  132007:
    "El contenido de la plantilla viola las políticas de Meta.",
  132012:
    "Los parámetros de la plantilla no respetan el formato que Meta espera.",
  132015:
    "La plantilla está pausada por baja calidad: Meta no la deja enviar hasta que se recupere.",
  132016:
    "La plantilla fue deshabilitada por calidad y ya no se puede enviar.",
  133010: "El número no está registrado en la Cloud API.",
  368: "El número está temporalmente bloqueado por infringir las políticas de Meta.",
};

/**
 * @param code   Código numérico da Meta (`errors[0].code`), se veio.
 * @param detail Texto cru da Meta, como reserva quando o código é novo.
 */
export function describeSendError(
  code: number | null | undefined,
  detail?: string | null
): string {
  const known = code != null ? DESCRIPTIONS[code] : undefined;
  // `||` e não `??`: a Meta às vezes envia o texto vazio ou em branco, e um
  // mensagem de erro vazia é tão inútil quanto o triângulo mudo.
  const base = known || detail?.trim() || "Meta rechazó el envío";
  return code != null ? `${base} (Meta ${code})` : base;
}
