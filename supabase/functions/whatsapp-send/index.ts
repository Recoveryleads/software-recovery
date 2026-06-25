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
    const { company_id, action, campaign_id, to, body: msgBody } = await req.json()

    // Carregar config WhatsApp da empresa
    const { data: company } = await sb
      .from('companies')
      .select('wa_phone_id, wa_token, wa_waba_id, wa_phone_number')
      .eq('id', company_id)
      .single()

    if (!company?.wa_phone_id || !company?.wa_token) {
      return new Response(JSON.stringify({ error: 'WhatsApp não configurado para esta empresa' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const { wa_phone_id, wa_token } = company
    const WA_API = `https://graph.facebook.com/v19.0/${wa_phone_id}/messages`

    // ── TESTAR LIGAÇÃO
    if (action === 'test') {
      const res  = await fetch(`https://graph.facebook.com/v19.0/${wa_phone_id}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${wa_token}` }
      })
      const data = await res.json()
      if (data.error) return new Response(JSON.stringify({ error: data.error.message }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ ok: true, display_phone: data.display_phone_number, name: data.verified_name }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // ── ENVIAR MENSAGEM DE TEXTO LIVRE (resposta no inbox)
    if (action === 'send_text') {
      const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: msgBody } }
      const res  = await fetch(WA_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wa_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (data.error) return new Response(JSON.stringify({ error: data.error.message }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

      const waId = data.messages?.[0]?.id
      await sb.from('wa_messages').insert({
        company_id,
        wa_msg_id:  waId,
        lead_phone: to,
        direction:  'out',
        body:       msgBody,
        delivered:  false,
      })

      return new Response(JSON.stringify({ ok: true, wa_id: waId }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── ENVIAR CAMPANHA
    if (action === 'send_campaign') {
      const { data: campaign } = await sb.from('campaigns').select('*').eq('id', campaign_id).single()
      if (!campaign) return new Response(JSON.stringify({ error: 'Campanha não encontrada' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

      // Buscar leads elegíveis
      let q = sb.from('leads').select('id, phone, name').eq('company_id', company_id).eq('status', 'new')
      if (campaign.campaign_filter) q = q.eq('campaign_name', campaign.campaign_filter)
      const { data: leads } = await q

      if (!leads?.length) {
        await sb.from('campaigns').update({ status: 'done' }).eq('id', campaign_id)
        return new Response(JSON.stringify({ ok: true, sent: 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      let sent = 0
      for (const lead of leads) {
        // Verificar se campanha ainda está running
        const { data: camp } = await sb.from('campaigns').select('status').eq('id', campaign_id).single()
        if (camp?.status !== 'running') break

        const phone = lead.phone.replace(/\D/g, '')

        // Enviar template
        const payload = {
          messaging_product: 'whatsapp',
          to: phone,
          type: 'template',
          template: {
            name: campaign.template_name,
            language: { code: campaign.template_lang || 'pt_PT' },
            components: lead.name ? [{
              type: 'body',
              parameters: [{ type: 'text', text: lead.name.split(' ')[0] }]
            }] : undefined
          }
        }

        const res  = await fetch(WA_API, {
          method: 'POST',
          headers: { Authorization: `Bearer ${wa_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const data = await res.json()

        const waId    = data.messages?.[0]?.id
        const failed  = !!data.error

        // Guardar mensagem enviada
        await sb.from('wa_messages').insert({
          company_id,
          wa_msg_id:   waId || `failed_${lead.id}_${Date.now()}`,
          lead_phone:  lead.phone,
          lead_name:   lead.name,
          direction:   'out',
          body:        `[Template: ${campaign.template_name}]`,
          campaign_id,
          delivered:   false,
          failed,
          error_code:  data.error?.code?.toString(),
        })

        // Actualizar estado do lead
        await sb.from('leads').update({
          status:          failed ? 'failed' : 'sent',
          sent_at:         new Date().toISOString(),
          wa_last_msg_id:  waId || null,
          campaign_name:   campaign.name,
        }).eq('id', lead.id)

        if (!failed) sent++

        // Actualizar contador da campanha
        await sb.from('campaigns').update({ sent_count: sent }).eq('id', campaign_id)

        // Aguardar intervalo configurado
        const delay = (campaign.delay_seconds || 5) * 1000
        await new Promise(r => setTimeout(r, delay))
      }

      await sb.from('campaigns').update({ status: 'done', sent_count: sent }).eq('id', campaign_id)
      return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Acção inválida' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
