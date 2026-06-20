import { z } from "zod"

export const ExperienceLevel = z.enum(["beginner", "trader"])
export type ExperienceLevel = z.infer<typeof ExperienceLevel>

export const UserPrefs = z
  .object({
    schema_version: z.literal(1),
    experience_level: ExperienceLevel.optional(),
    onboarded_at: z.string().datetime({ offset: true }).optional(),
    finny_home: z.string().optional(),
  })
  .strict()
  .superRefine((prefs, ctx) => {
    const hasExperience = prefs.experience_level !== undefined
    const hasOnboardedAt = prefs.onboarded_at !== undefined
    if (hasExperience === hasOnboardedAt) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "experience_level and onboarded_at must be set together",
      path: hasExperience ? ["onboarded_at"] : ["experience_level"],
    })
  })
export type UserPrefs = z.infer<typeof UserPrefs>

export const PREFS_FILENAME = "prefs.md"
