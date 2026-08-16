import { z } from "zod";

export const HealthStatusSchema = z.object({
  healthy: z.boolean(),
  whatsapp: z.enum(["connected", "connecting"]),
  whatsappQr: z.string().nullable(),
  messagesToday: z.number(),
  targetGroups: z.number(),
  uptime: z.number(),
});

export const ScraperHealthSchema = z.object({
  source_id: z.string(),
  source_type: z.string(),
  last_success: z.number(),
  last_attempt: z.number(),
  error_count: z.number(),
});

export const SourceSchema = z.object({
  id: z.number(),
  name: z.string(),
  source_id: z.string(),
  type: z.string(),
  is_active: z.boolean(),
});

export const CategorySchema = z.object({
  id: z.number(),
  slug: z.string(),
  display_name: z.string(),
  bot_token: z.string().nullable().optional(),
  chat_id: z.string().nullable().optional(),
  ai_prompt: z.string().nullable().optional(),
  is_active: z.boolean(),
  delivery_channel: z.string().nullable().optional(),
  whatsapp_delivery_jid: z.string().nullable().optional(),
});

export const ScheduleRuleSchema = z.object({
  id: z.number(),
  category_slug: z.string(),
  cron_expression: z.string(),
  label: z.string(),
  is_active: z.boolean(),
  is_running: z.boolean().optional(),
});

export const TelegramStatusSchema = z.object({
  isReady: z.boolean(),
  tempPhone: z.string().nullable(),
});

export const CookieStatusSchema = z.object({
  site: z.string(),
  has_cookies: z.boolean(),
  updated_at: z.string().nullable(),
});

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
  });

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type ScraperHealth = z.infer<typeof ScraperHealthSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;
export type TelegramStatus = z.infer<typeof TelegramStatusSchema>;
export type CookieStatus = z.infer<typeof CookieStatusSchema>;
