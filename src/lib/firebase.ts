import { getApp, getApps, initializeApp } from '@firebase/app'
import { getMessaging, isSupported, type Messaging } from '@firebase/messaging'

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
}

export const hasFirebaseConfig = Object.values(firebaseConfig).every(value => Boolean(value?.trim()))

function firebasePublicConfig() {
  const { apiKey, authDomain, projectId, messagingSenderId, appId } = firebaseConfig
  return { apiKey, authDomain, projectId, messagingSenderId, appId }
}

export function firebaseServiceWorkerUrl() {
  const url = new URL('/sw.js', window.location.origin)
  if (hasFirebaseConfig) {
    // Firebase web config and VAPID are public browser values; no backend secrets go to the worker.
    url.searchParams.set('firebaseConfig', JSON.stringify(firebasePublicConfig()))
  }
  return `${url.pathname}${url.search}`
}

export async function getBrowserMessaging(): Promise<Messaging | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !hasFirebaseConfig) return null
  try {
    if (!(await isSupported())) return null
    const app = getApps().length ? getApp() : initializeApp(firebasePublicConfig())
    return getMessaging(app)
  } catch {
    return null
  }
}

export async function getPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(firebaseServiceWorkerUrl(), { scope: '/' })
}
