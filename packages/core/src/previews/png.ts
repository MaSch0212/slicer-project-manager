const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** Reads width/height from IHDR, which the format requires to be the first chunk. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null
  if (new TextDecoder().decode(bytes.subarray(12, 16)) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
