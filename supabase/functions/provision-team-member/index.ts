import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders })
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = request.headers.get('authorization')
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!authorization?.startsWith('Bearer ') || !url || !anonKey || !serviceRoleKey) {
    return json({ error: 'Authenticated team provisioning is not configured' }, 401)
  }

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: { user }, error: authError } = await callerClient.auth.getUser()
  if (authError || !user) return json({ error: 'Sign in as an administrator to create employee accounts' }, 401)

  const { data: profile, error: profileError } = await callerClient
    .from('profiles').select('role,active').eq('id', user.id).maybeSingle()
  if (profileError || profile?.role !== 'ADMIN' || profile.active !== true) {
    return json({ error: 'Only an active administrator can create employee accounts' }, 403)
  }

  let input: { email?: unknown; fullName?: unknown; password?: unknown }
  try { input = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  if (fullName.length < 1 || fullName.length > 120) return json({ error: 'Enter a name between 1 and 120 characters' }, 400)
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400)
  if (password.length < 12 || password.length > 128) return json({ error: 'Initial password must be between 12 and 128 characters' }, 400)

  const adminClient = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error) {
    const message = /already|registered|exists/i.test(error.message)
      ? 'An Auth account already exists for this email.'
      : /password|weak/i.test(error.message)
        ? 'The initial password does not meet the Supabase password policy.'
        : 'Supabase could not create the employee account. Check the Auth configuration and try again.'
    return json({ error: message }, 400)
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: user.id,
    entity_type: 'profile',
    entity_id: data.user.id,
    action: 'profile_provisioned',
    details: { role: 'EMPLOYEE', method: 'admin_direct_create' },
    metadata: { email },
  })
  if (auditError) console.error('Employee account was created, but its audit event could not be recorded.')

  return json({ userId: data.user.id, email: data.user.email ?? email, message: 'Employee account created. Share the initial password securely.' })
})
