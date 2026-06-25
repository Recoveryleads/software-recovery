import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

serve(async (req) => {
  const url = new URL(req.url)

  // ── Verificação do webhook (GET da Meta)
  if (req.method === 'GET') {
    const mode      = url.searchParams.get('hub.mode')
    const token     = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    if (mode === 'subscribe') {
      // Verificar contra todos os verify_tokens das empresas
      const { data: companies } = await sb
        .from('companies')
        .select('id, wa_verify_token')
        .not('wa_verify_token', 'is', null)

      const match = (companies || []).find(c => c.wa_verify_token === token)
      if (match) return new Response(challenge, { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }

  // ── Receber eventos (POST da Meta)
  if (req.method === 'POST') {
    const body = await req.json()

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value

        // Encontrar empresa pelo phone_number_id
        const phoneNumberId = value.metadata?.phone_number_id
        if (!phoneNumberId) continue

        const { data: company } = await sb
          .from('companies')
          .select('id')
          .eq('wa_phone_id', phoneNumberId)
          .single()

        if (!company) continue
        const companyId = company.id

        // ── Mensagens recebidas
        for (const msg of (value.messages || [])) {
          const phone = msg.from
          const body  = msg.text?.body || msg.interactive?.button_reply?.title || msg.type

          // Buscar nome do lead
          const { data: lead } = await sb
            .from('leads')
            .select('name')
            .eq('company_id', companyId)
            .eq('phone', phone)
            .single()

          // Guardar mensagem
          await sb.from('wa_messages').upsert({
            company_id:  companyId,
            wa_msg_id:   msg.id,
            lead_phone:  phone,
            lead_name:   lead?.name || phone,
            direction:   'in',
            body,
            created_at:  new Date(parseInt(msg.timestamp) * 1000).toISOString(),
          }, { onConflict: 'wa_msg_id', ignoreDuplicates: true })

          // Actualizar estado do lead para "responded"
          await sb.from('leads')
            .update({ status: 'responded', responded_at: new Date().toISOString() })
            .eq('company_id', companyId)
            .eq('phone', phone)
            .in('status', ['sent', 'delivered'])

          // Actualizar contact_messages (retrocompatibilidade com o dashboard existente)
          await sb.from('contact_messages')
            .update({ responded_at: new Date().toISOString().split('T')[0] })
            .eq('company_id', companyId)
            .eq('contact_id', phone)
            .is('responded_at', null)
        }

        // ── Status de entrega
        for (const status of (value.statuses || [])) {
          const waId = status.id

          if (status.status === 'delivered') {
            await sb.from('wa_messages')
              .update({ delivered: true, delivered_at: new Date(parseInt(status.timestamp) * 1000).toISOString() })
              .eq('wa_msg_id', waId)

            await sb.from('leads')
              .update({ status: 'delivered', delivered_at: new Date().toISOString() })
              .eq('company_id', companyId)
              .eq('wa_last_msg_id', waId)
              .eq('status', 'sent')
          }

          if (status.status === 'failed') {
            await sb.from('wa_messages')
              .update({ failed: true, error_code: status.errors?.[0]?.code?.toString() })
              .eq('wa_msg_id', waId)

            await sb.from('leads')
              .update({ status: 'failed' })
              .eq('company_id', companyId)
              .eq('wa_last_msg_id', waId)
          }
        }
      }
    }

    return new Response('OK', { status: 200 })
  }

  return new Response('Method Not Allowed', { status: 405 })
})
