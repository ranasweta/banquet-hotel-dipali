'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, Check, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Aadhaar capture for the KYC step (FR-1.10). The guest can either hold the card up to the
 * device camera — a live capture, for when they don't have a file — or upload an image.
 * Either way the result is handed back as a File and stored through the same encrypted
 * documents endpoint; the image never leaves this component except via that upload.
 */
export function AadhaarCapture({
  label,
  done,
  disabled,
  onFile,
}: {
  label: string
  done: boolean
  disabled?: boolean
  onFile: (file: File) => Promise<void> | void
}) {
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setLive(false)
  }

  // Always release the camera when this card unmounts.
  useEffect(() => () => stopCamera(), [])

  async function startCamera() {
    if (disabled) return
    try {
      // Prefer the rear camera on a phone; falls back to whatever is available.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      streamRef.current = stream
      setLive(true)
      // The <video> mounts with `live`, so attach on the next tick.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play()
        }
      })
    } catch {
      toast.error('Could not open the camera. Check the browser permission, or upload a file instead.')
    }
  }

  async function capture() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')?.drawImage(video, 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob) throw new Error('Capture failed')
      await onFile(new File([blob], `${label.toLowerCase().replace(/\s+/g, '-')}.jpg`, { type: 'image/jpeg' }))
      stopCamera()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Capture failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex items-center gap-2 font-medium">
        {done && <Check className="size-4 text-emerald-600" />}
        {label}
      </div>

      {live ? (
        <div className="space-y-2">
          <video ref={videoRef} playsInline muted className="w-full rounded-md bg-black" />
          <div className="flex gap-2">
            <Button size="sm" onClick={capture} disabled={busy}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Camera className="mr-2 size-4" />}
              Capture
            </Button>
            <Button size="sm" variant="outline" onClick={stopCamera} disabled={busy}>
              <X className="mr-2 size-4" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Button size="sm" variant="outline" onClick={startCamera} disabled={disabled}>
            <Camera className="mr-2 size-4" />
            Capture with camera
          </Button>
          <p className="text-xs text-muted-foreground">or upload an image</p>
          <Input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </div>
      )}
    </div>
  )
}
