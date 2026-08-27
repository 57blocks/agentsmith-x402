import { z } from 'zod';

const plainObject = z.record(z.unknown());

export const paymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9-]+$/),
  amount: z.string().regex(/^[0-9]+$/),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: plainObject.default({}),
}).passthrough();

export const paymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  accepted: paymentRequirementsSchema,
  payload: plainObject,
  resource: plainObject.optional(),
  extensions: plainObject.optional(),
}).passthrough();

export const facilitatorRequestSchema = z.object({
  x402Version: z.literal(2),
  paymentPayload: paymentPayloadSchema,
  paymentRequirements: paymentRequirementsSchema,
}).superRefine((request, context) => {
  if (request.x402Version !== request.paymentPayload.x402Version) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['x402Version'], message: 'version mismatch' });
  }
});

export type FacilitatorRequest = z.infer<typeof facilitatorRequestSchema>;

export function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.join('.') || 'body';
  return `${path}: ${issue?.message || 'invalid request'}`;
}
