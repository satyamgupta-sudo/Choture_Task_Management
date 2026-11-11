import { useEffect, useRef, useState } from 'react'
import './camera-capture.css'

const MAX_PHOTO_BYTES = 5 * 1024 * 1024

export default function CameraCapture({ onCapture }: { onCapture: (blob: Blob | null) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const previewUrl = useRef<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  function stopCamera() {
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
    setCameraReady(false)
  }

  useEffect(() => () => {
    stream.current?.getTracks().forEach(track => track.stop())
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
  }, [])

  async function startCamera() {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera capture requires a supported browser on HTTPS (or localhost).')
      return
    }
    setStarting(true)
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      const element = video.current
      if (!element) {
        nextStream.getTracks().forEach(track => track.stop())
        return
      }
      stream.current?.getTracks().forEach(track => track.stop())
      stream.current = nextStream
      element.srcObject = nextStream
      await element.play()
      setCameraReady(true)
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : ''
      setError(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Camera permission was denied. Allow camera access in your browser settings and try again.'
        : name === 'NotFoundError'
          ? 'No camera was found on this device.'
          : 'Could not start the camera. Check browser permissions and try again.')
      stopCamera()
    } finally {
      setStarting(false)
    }
  }

  function capture() {
    const element = video.current
    if (!element || !cameraReady || !element.videoWidth || !element.videoHeight) {
      setError('The camera is still starting. Wait a moment and try again.')
      return
    }
    const scale = Math.min(1, 1920 / element.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(element.videoWidth * scale)
    canvas.height = Math.round(element.videoHeight * scale)
    const context = canvas.getContext('2d')
    if (!context) {
      setError('Could not process this photo. Please try again.')
      return
    }
    context.drawImage(element, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(blob => {
      if (!blob) {
        setError('Could not create a photo. Please try again.')
        return
      }
      if (blob.size > MAX_PHOTO_BYTES) {
        setError('This photo is over the 5 MB limit. Move closer to the subject and retake it.')
        return
      }
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = URL.createObjectURL(blob)
      setPreview(previewUrl.current)
      onCapture(blob)
      stopCamera()
      setError('')
    }, 'image/jpeg', 0.82)
  }

  function retake() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = null
    setPreview(null)
    onCapture(null)
    void startCamera()
  }

  return <div className="camera-box">
    {error && <p className="error-text" role="alert">{error}</p>}
    {preview
      ? <>
          <img className="camera-preview" src={preview} alt="Captured task evidence preview" />
          <button type="button" className="button button-secondary" onClick={retake}>Retake photo</button>
          <p className="muted small">Captured with your camera. This photo uploads to private storage when submitted.</p>
        </>
      : <>
          <video ref={video} autoPlay playsInline muted className="camera-preview" aria-label="Live camera view" />
          {!cameraReady
            ? <button type="button" className="button button-secondary" disabled={starting} onClick={() => void startCamera()}>{starting ? 'Starting camera…' : 'Start camera'}</button>
            : <button type="button" className="button button-primary" onClick={capture}>Capture photo</button>}
          <p className="muted small">Camera access is requested only when you start capture. Photo upload is private.</p>
        </>}
  </div>
}
