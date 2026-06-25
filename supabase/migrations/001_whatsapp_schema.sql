-- ============================================================
-- WhatsApp Business API — Schema completo
-- Corre este script no Supabase SQL Editor
-- ============================================================

-- ── Adicionar colunas WhatsApp à tabela companies existente
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS wa_phone_id     TEXT,
  ADD COLUMN IF NOT EXISTS wa_waba_id      TEXT,
  ADD COLUMN IF NOT EXISTS wa_token        TEXT,
  ADD COLUMN IF NOT EXISTS wa_verify_token TEXT,
  ADD COLUMN IF NOT EXISTS wa_phone_number TEXT;

-- ── Leads importados via CSV
CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  name            TEXT,
  email           TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','sent','delivered','responded','converted','unsubscribed','failed')),
  campaign_name   TEXT,
  wa_last_msg_id  TEXT,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  responded_at    TIMESTAMPTZ,
  notes           TEXT,
  extra_data      JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, phone)
);

-- ── Campanhas de envio
CREATE TABLE IF NOT EXISTS campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  template_name    TEXT NOT NULL,
  template_lang    TEXT DEFAULT 'pt_PT',
  campaign_filter  TEXT,
  delay_seconds    INTEGER DEFAULT 5,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','running','paused','done')),
  total_leads      INTEGER DEFAULT 0,
  sent_count       INTEGER DEFAULT 0,
  responded_count  INTEGER DEFAULT 0,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Mensagens WhatsApp (in + out)
CREATE TABLE IF NOT EXISTS wa_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wa_msg_id     TEXT UNIQUE,
  lead_phone    TEXT NOT NULL,
  lead_name     TEXT,
  campaign_id   UUID REFERENCES campaigns(id),
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  body          TEXT,
  type          TEXT DEFAULT 'text',
  delivered     BOOLEAN DEFAULT FALSE,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  failed        BOOLEAN DEFAULT FALSE,
  error_code    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Índices para performance
CREATE INDEX IF NOT EXISTS idx_leads_company_status  ON leads (company_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_company_phone   ON leads (company_id, phone);
CREATE INDEX IF NOT EXISTS idx_campaigns_company     ON campaigns (company_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_company   ON wa_messages (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone     ON wa_messages (company_id, lead_phone);

-- ── Row Level Security
ALTER TABLE leads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns   ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;

-- RLS: admins e operadores vêem tudo; clientes vêem as suas empresas
CREATE POLICY "leads_read" ON leads FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator'))
    OR
    EXISTS (SELECT 1 FROM client_companies WHERE client_id = auth.uid() AND company_id = leads.company_id)
  );

CREATE POLICY "leads_write" ON leads FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator'))
  );

CREATE POLICY "campaigns_read" ON campaigns FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator'))
    OR
    EXISTS (SELECT 1 FROM client_companies WHERE client_id = auth.uid() AND company_id = campaigns.company_id)
  );

CREATE POLICY "campaigns_write" ON campaigns FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator'))
  );

CREATE POLICY "wa_messages_read" ON wa_messages FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator'))
    OR
    EXISTS (SELECT 1 FROM client_companies WHERE client_id = auth.uid() AND company_id = wa_messages.company_id)
  );

CREATE POLICY "wa_messages_write" ON wa_messages FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator'))
  );

-- ── Trigger para updated_at em leads
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Trigger para contar respostas nas campanhas automaticamente
CREATE OR REPLACE FUNCTION update_campaign_responded_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.direction = 'in' AND NEW.campaign_id IS NOT NULL THEN
    UPDATE campaigns
    SET responded_count = (
      SELECT COUNT(DISTINCT lead_phone)
      FROM wa_messages
      WHERE campaign_id = NEW.campaign_id AND direction = 'in'
    )
    WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wa_messages_responded
  AFTER INSERT ON wa_messages
  FOR EACH ROW EXECUTE FUNCTION update_campaign_responded_count();
