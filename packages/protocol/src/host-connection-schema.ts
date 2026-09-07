import { z } from "zod";

export const ProxyBasePathSchema = z.string().regex(/^\/daemons\/[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const DirectTcpHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("directTcp"),
  endpoint: z.string(),
  useTls: z.boolean().optional().default(false),
  basePath: ProxyBasePathSchema.optional(),
  password: z.string().optional(),
});

export type DirectTcpHostConnection = z.input<typeof DirectTcpHostConnectionSchema>;
export type NormalizedDirectTcpHostConnection = z.output<typeof DirectTcpHostConnectionSchema>;
