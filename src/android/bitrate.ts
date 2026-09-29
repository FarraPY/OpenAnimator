/** Bitrate automático de la exportación en la tablet (lo usan el exportador y la estimación de tamaño). */
export type ExportQuality = 'low' | 'medium' | 'high' | 'max'

/** Bits por píxel y por fotograma según la calidad (gráficos con texto nítido: generoso). */
const BPP: Record<ExportQuality, number> = { low: 0.05, medium: 0.08, high: 0.12, max: 0.2 }

export function autoBitrate(w: number, h: number, fps: number, quality: ExportQuality, codec: 'avc' | 'hevc') {
  const bps = w * h * fps * (BPP[quality] ?? BPP.high) * (codec === 'hevc' ? 0.7 : 1)
  return Math.round(Math.min(100_000_000, Math.max(1_000_000, bps)))
}
