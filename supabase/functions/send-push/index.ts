// Internal notification-insert webhook. Firebase credentials and the service
// role key stay in the Edge Function environment; neither reaches the browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { JWT } from 'https://esm.sh/google-auth-library@9'

type NotificationRow = { id: string; recipient_id: string; title: string; message: string }

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  let body: { notification_id?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  if (!body.notification_id || !/^[0-9a-f-]{36}$/i.test(body.notification_id)) {
    return Response.json({ error: 'A notification ID is required' }, { status: 400 })
  }
  const hookSecret = Deno.env.get('NOTIFICATION_WEBHOOK_SECRET')
  const timestamp = req.headers.get('x-notification-timestamp') ?? ''
  const suppliedSignature = req.headers.get('x-notification-signature') ?? ''
  const timestampNumber = Number(timestamp)
  if (!hookSecret || !/^\d{10,12}$/.test(timestamp) || !Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300 || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
    return new Response('Unauthorized', { status: 401 })
  }
  const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(hookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signatureBytes = new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(`${body.notification_id}.${timestamp}`)))
  const expectedSignature = Array.from(signatureBytes, value => value.toString(16).padStart(2, '0')).join('')
  let difference = expectedSignature.length ^ suppliedSignature.length
  for (let index = 0; index < Math.min(expectedSignature.length, suppliedSignature.length); index++) {
    difference |= expectedSignature.charCodeAt(index) ^ suppliedSignature.charCodeAt(index)
  }
  if (difference !== 0) return new Response('Unauthorized', { status: 401 })

  const firebaseJson = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON')
  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!firebaseJson || !url || !serviceKey) {
    return Response.json({ error: 'Browser push is not configured; in-app alerts remain available.' }, { status: 503 })
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: notification, error: notificationError } = await db
    .from('notifications')
    .select('id,recipient_id,title,message')
    .eq('id', body.notification_id)
    .maybeSingle()
  if (notificationError) return Response.json({ error: 'Could not verify notification' }, { status: 500 })
  if (!notification) return Response.json({ error: 'Notification not found' }, { status: 404 })

  const row = notification as NotificationRow
  const { data: subscriptions, error: subscriptionError } = await db
    .from('push_subscriptions').select('id,token').eq('user_id', row.recipient_id)
  if (subscriptionError) return Response.json({ error: 'Could not load push subscriptions' }, { status: 500 })
  if (!subscriptions?.length) return Response.json({ sent: 0, reason: 'No subscribed devices' })

  let account: { client_email: string; private_key: string; project_id: string }
  try { account = JSON.parse(firebaseJson) } catch { return Response.json({ error: 'Firebase service account secret is invalid' }, { status: 503 }) }
  if (!account.client_email || !account.private_key || !account.project_id) {
    return Response.json({ error: 'Firebase service account secret is incomplete' }, { status: 503 })
  }

  try {
    const jwt = new JWT({ email: account.client_email, key: account.private_key, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] })
    const access = await jwt.getAccessToken()
    if (!access.token) throw new Error('Firebase access token unavailable')

    const results = await Promise.all(subscriptions.map(async subscription => {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: {
          token: subscription.token,
          // Data-only delivery lets the installed root worker show exactly one
          // background notification; foreground clients reconcile via Realtime.
          data: { notification_id: row.id, title: row.title, body: row.message, url: '/' },
        } }),
      })
      if (response.status === 404 || response.status === 410) {
        await db.from('push_subscriptions').delete().eq('id', subscription.id)
      }
      return response.ok
    }))
    return Response.json({ sent: results.filter(Boolean).length, attempted: results.length })
  } catch {
    return Response.json({ error: 'Firebase delivery failed; the in-app notification is still available.' }, { status: 502 })
  }
})
