-- RC97: Keep the vehicle plate with the driver's pending ADMIN application.
-- Adding an empty default preserves older Flutter submissions that do not yet send plate.
-- Driver approval later copies this value to the existing driver_profiles.plate column.
ALTER TABLE "onboarding_applications"
  ADD COLUMN IF NOT EXISTS "plate" VARCHAR(30) NOT NULL DEFAULT '';
