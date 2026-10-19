import { isMockEnabled } from "@/lib/env";

/**
 * Gate do ambiente de testes interno (FR-080).
 * Os mocks só existem com WA_MOCK_ENABLED=true E fora de produção;
 * em qualquer outro caso respondem 404 incondicional, indistinguível de uma
 * rota inexistente.
 */
export function mockGuard(): Response | null {
  if (!isMockEnabled()) {
    return new Response(null, { status: 404 });
  }
  return null;
}
