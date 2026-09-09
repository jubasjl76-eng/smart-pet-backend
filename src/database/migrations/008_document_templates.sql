-- Phase 7 slice 2 — editable document templates for generated paperwork.
-- Idempotent. A kennel only has a row here once it edits a template away from
-- the built-in default (src/breeder/logic/docTemplates.ts).

CREATE TABLE IF NOT EXISTS document_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id  VARCHAR(255) NOT NULL,
  slug       VARCHAR(40) NOT NULL,   -- contract | deposit-receipt | health-guarantee | microchip-handoff
  title      VARCHAR(255) NOT NULL,
  body       TEXT NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (kennel_id, slug)
);
