import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const APP_ID     = Deno.env.get('META_APP_ID')!
const APP_SECRET = Deno.env.get('META_APP_SECRET')!

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { action, code, company_id, redirect_uri } = await req.json()

    // ── TROCAR CODE POR TOKEN + BUSCAR DETALHES WABA
    if (action === 'exchange_code') {
      // 1. Trocar code por user access token
      const tokenRes = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&code=${code}&redirect_uri=${encodeURIComponent(redirect_uri)}`
      )
      const tokenData = await tokenRes.json()
      if (tokenData.error) return json({ error: tokenData.error.message }, CORS)

      const userToken = tokenData.access_token

      // 2. Buscar WhatsApp Business Accounts associadas
      const wabaRes  = await fetch(
        `https://graph.facebook.com/v19.0/me/businesses?fields=whatsapp_business_accounts{id,name,currency,timezone_id,message_template_namespace}&access_token=${userToken}`
      )
      const wabaData = await wabaRes.json()

      const wabas = wabaData.data?.[0]?.whatsapp_business_accounts?.data || []
      if (!wabas.length) return json({ error: 'Nenhuma conta WhatsApp Business encontrada.' }, CORS)

      const waba = wabas[0]

      // 3. Buscar números de telefone da WABA
      const phoneRes  = await fetch(
        `https://graph.facebook.com/v19.0/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status&access_token=${userToken}`
      )
      const phoneData = await phoneRes.json()
      const phone = phoneData.data?.[0]

      if (!phone) return json({ error: 'Nenhum número de telefone encontrado na conta.' }, CORS)

      // 4. Gerar System User Token de longa duração
      // (Usar o user token directamente por agora — em produção usar System User)
      const longTokenRes  = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${userToken}`
      )
      const longTokenData = await longTokenRes.json()
      const longToken = longTokenData.access_token || userToken

      // 5. Guardar na empresa
      if (company_id) {
        await sb.from('companies').update({
          wa_phone_id:     phone.id,
          wa_waba_id:      waba.id,
          wa_token:        longToken,
          wa_phone_number: phone.display_phone_number,
          wa_verified_name: phone.verified_name,
          wa_quality:      phone.quality_rating,
        }).eq('id', company_id)
      }

      return json({
        ok: true,
        waba_id:      waba.id,
        waba_name:    waba.name,
        phone_id:     phone.id,
        phone_number: phone.display_phone_number,
        verified_name: phone.verified_name,
        quality:      phone.quality_rating,
      }, CORS)
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
