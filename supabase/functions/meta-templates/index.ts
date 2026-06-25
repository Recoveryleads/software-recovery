import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { action, company_id, template } = await req.json()

    // Carregar config da empresa
    const { data: company } = await sb
      .from('companies')
      .select('wa_waba_id, wa_token')
      .eq('id', company_id)
      .single()

    if (!company?.wa_waba_id || !company?.wa_token) {
      return json({ error: 'WhatsApp não configurado para esta empresa' }, CORS)
    }

    const { wa_waba_id, wa_token } = company

    // ── LISTAR TEMPLATES
    if (action === 'list') {
      const res  = await fetch(
        `https://graph.facebook.com/v19.0/${wa_waba_id}/message_templates?fields=id,name,status,category,language,components,rejected_reason,quality_score&limit=100&access_token=${wa_token}`
      )
      const data = await res.json()
      if (data.error) return json({ error: data.error.message }, CORS)
      return json({ ok: true, templates: data.data || [] }, CORS)
    }

    // ── CRIAR TEMPLATE
    if (action === 'create') {
      const res  = await fetch(
        `https://graph.facebook.com/v19.0/${wa_waba_id}/message_templates`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${wa_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(template)
        }
      )
      const data = await res.json()
      if (data.error) return json({ error: data.error.message }, CORS)
      return json({ ok: true, id: data.id, status: data.status }, CORS)
    }

    // ── APAGAR TEMPLATE
    if (action === 'delete') {
      const res  = await fetch(
        `https://graph.facebook.com/v19.0/${wa_waba_id}/message_templates?name=${template.name}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${wa_token}` } }
      )
      const data = await res.json()
      if (data.error) return json({ error: data.error.message }, CORS)
      return json({ ok: true }, CORS)
    }

    return json({ error: 'Acção inválida' }, CORS)

  } catch (e) {
    return json({ error: e.message }, CORS)
  }
})

function json(data: unknown, cors: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    headers: { ...cors, 'Content-Type': 'application/json' }
  })
}
