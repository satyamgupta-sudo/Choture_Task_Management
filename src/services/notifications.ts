import { getToken, onMessage, type MessagePayload } from '@firebase/messaging'
import { supabase } from '../lib/supabase'
import { firebaseConfig, getBrowserMessaging, getPushServiceWorker, hasFirebaseConfig } from '../lib/firebase'
import { pushPermissionFallback } from '../lib/push-notifications'

export type PushOptInResult = { enabled: boolean; message: string }
type NotificationRow = { id: string; recipient_id: string; [key: string]: unknown }
const fallback = 'In-app notifications and Supabase Realtime remain on.'

async function saveToken(userId: string, token: string) {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from('push_subscriptions').upsert(
    { user_id: userId, token, updated_at: new Date().toISOString() },
    { onConflict: 'token' },
  )
  if (error) throw error
}

async function currentToken() {
  if (!hasFirebaseConfig || !('Notification' in window) || Notification.permission !== 'granted') return null
  const messaging = await getBrowserMessaging()
  if (!messaging) return null
  const registration = await getPushServiceWorker()
  return getToken(messaging, { vapidKey: firebaseConfig.vapidKey, serviceWorkerRegistration: registration })
}

/** Call only from the explicit Enable Notifications click. */
export async function requestPushOptIn(): Promise<PushOptInResult> {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
    return { enabled: false, message: `This browser does not support browser notifications. ${fallback}` }
  }
  if (!supabase) return { enabled: false, message: `Connect Supabase before enabling browser notifications. ${fallback}` }
  if (!hasFirebaseConfig) return { enabled: false, message: `Firebase web settings are missing. ${fallback}` }
  if (!(await getBrowserMessaging())) return { enabled: false, message: `Browser push is unsupported. ${fallback}` }

  let permission = Notification.permission
  // Never repeat a prompt: requestPermission is called only from the click and only once from default.
  if (permission === 'default') permission = await Notification.requestPermission()
  if (permission !== 'granted') return { enabled: false, message: pushPermissionFallback(permission) }

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { enabled: false, message: `Sign in again to enable browser notifications. ${fallback}` }
    const token = await currentToken()
    if (!token) return { enabled: false, message: `Push is unavailable in this browser. ${fallback}` }
    await saveToken(user.id, token)
    return { enabled: true, message: 'Browser notifications are enabled on this device.' }
  } catch {
    return { enabled: false, message: `Browser notifications could not be enabled. ${fallback}` }
  }
}

/** Re-checks token rotation without prompting; FCM Web exposes rotation through getToken(). */
export async function syncPushToken(userId: string) {
  if (!supabase) return
  try {
    const token = await currentToken()
    if (token) await saveToken(userId, token)
  } catch {
    // Push is optional; leave the in-app channel unaffected.
  }
}

/** Remove this browser's token under the signed-in user's RLS scope before logout. */
export async function removeCurrentPushToken(userId: string) {
  if (!supabase) return
  try {
    const token = await currentToken()
    if (!token) return
    const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', userId).eq('token', token)
    if (error) throw error
  } catch {
    // Auth logout still proceeds if a browser or network prevents optional token cleanup.
  }
}

/** Foreground FCM only reconciles the existing Realtime notification row, avoiding a second alert. */
export async function listenForForegroundPush(
  userId: string,
  onNotification: (row: NotificationRow) => void,
) {
  const messaging = await getBrowserMessaging()
  if (!messaging || !supabase) return () => undefined
  const listener = onMessage(messaging, async (payload: MessagePayload) => {
    const id = payload.data?.notification_id
    if (!id) return
    const { data } = await supabase.from('notifications').select('*').eq('id', id).eq('recipient_id', userId).maybeSingle()
    if (data) onNotification(data as NotificationRow)
  })
  return listener
}
