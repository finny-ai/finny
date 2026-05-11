import { z } from "zod"

export const ExperienceLevel = z.enum(["beginner", "trader"])
export type ExperienceLevel = z.infer<typeof ExperienceLevel>

export const UserPrefs = z
  .object({
    schema_version: z.literal(1),
    experience_level: ExperienceLevel,
    onboarded_at: z.string().datetime({ offset: true }),
  })
  .strict()
export type UserPrefs = z.infer<typeof UserPrefs>

export const PREFS_FILENAME = "prefs.md"
