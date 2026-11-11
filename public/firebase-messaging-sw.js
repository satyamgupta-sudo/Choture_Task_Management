/* Imported by /sw.js so PWA and FCM share one root-scope registration. */
importScripts('https://www.gstatic.com/firebasejs/13.2.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging-compat.js')

let config
try {
  config = JSON.parse(new URL(self.location.href).searchParams.get('firebaseConfig') || 'null')
} catch {
  config = null
}

if (config?.apiKey && config?.projectId && config?.messagingSenderId && config?.appId) {
  firebase.initializeApp(config)
  const messaging = firebase.messaging()
  messaging.onBackgroundMessage(payload => {
    // The server sends data-only messages so exactly one notification is shown.
    const title = payload.data?.title || 'Choture task update'
    return self.registration.showNotification(title, {
      body: payload.data?.body || 'Your restaurant task list has an update.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.data?.url || '/', notificationId: payload.data?.notification_id },
    })
  })

  self.addEventListener('notificationclick', event => {
    event.notification.close()
    const target = event.notification.data?.url || '/'
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => 'focus' in client)
      if (existing) {
        existing.navigate(target)
        return existing.focus()
      }
      return self.clients.openWindow(target)
    }))
  })
}
