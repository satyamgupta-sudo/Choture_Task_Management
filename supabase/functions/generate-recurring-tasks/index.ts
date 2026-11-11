// Invoke this function from a trusted scheduled job every 15 minutes.
// CRON_SECRET protects the HTTP endpoint; the service role is kept server-side.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function localDate(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find(value => value.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const secret = Deno.env.get('CRON_SECRET')
  const timestamp = req.headers.get('x-cron-timestamp') ?? ''
  const suppliedSignature = req.headers.get('x-cron-signature') ?? ''
  const timestampNumber = Number(timestamp)
  if (!secret || !/^\d{10,12}$/.test(timestamp) || !Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300 || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
    return new Response('Unauthorized', { status: 401 })
  }
  const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signatureBytes = new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(`generate-recurring-tasks.${timestamp}`)))
  const expectedSignature = Array.from(signatureBytes, value => value.toString(16).padStart(2, '0')).join('')
  let difference = expectedSignature.length ^ suppliedSignature.length
  for (let index = 0; index < Math.min(expectedSignature.length, suppliedSignature.length); index++) {
    difference |= expectedSignature.charCodeAt(index) ^ suppliedSignature.charCodeAt(index)
  }
  if (difference !== 0) return new Response('Unauthorized', { status: 401 })

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) return Response.json({ error: 'Scheduled task service is not configured' }, { status: 500 })

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: rules, error } = await db.from('task_recurrences').select('id,timezone').eq('active', true).eq('is_active', true)
  if (error) return Response.json({ error: 'Could not load active recurrence rules' }, { status: 500 })

  let generated = 0
  let skipped = 0
  let failed = 0
  for (const rule of rules ?? []) {
    let instanceDate: string
    try {
      instanceDate = localDate(rule.timezone || 'UTC')
    } catch {
      failed++
      continue
    }
    const { data, error: generationError } = await db.rpc('generate_recurring_task_instance', {
      p_recurrence_id: rule.id,
      p_instance_date: instanceDate,
    })
    if (generationError) failed++
    else if (data) generated++
    else skipped++
  }
  return Response.json({ generated, skipped, failed })
})
