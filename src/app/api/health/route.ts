import { checkHealth } from "@/server/health";

export const dynamic = "force-dynamic";

// Só o handler: o que se responde e por que vive em `src/server/health.ts`.
export async function GET() {
  const { status, body } = await checkHealth();
  return Response.json(body, { status });
}
