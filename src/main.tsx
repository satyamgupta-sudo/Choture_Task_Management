import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'
import './production.css'
import { BrowserRouter } from 'react-router-dom'
import { firebaseServiceWorkerUrl } from './lib/firebase'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(firebaseServiceWorkerUrl(), { scope: '/' }).catch(() => {
      // The app remains fully usable when the browser blocks PWA registration.
    })
  })
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>)
