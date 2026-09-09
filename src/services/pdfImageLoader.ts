/**
 * pdfImageLoader.ts
 * Session 81 (owner request) — school logo, student passport photo, and
 * class-teacher/principal signature images on the printed report card.
 *
 * jsPDF's doc.addImage() needs actual image bytes (a base64 data URL or
 * equivalent), not a network URL — it cannot fetch a URL itself. Every
 * image source this file deals with (schools.logo_url, students.photo_url,
 * class_form_masters.signature_url) is ultimately resolved to either a
 * public URL or a short-lived Supabase signed URL by the caller BEFORE
 * reaching here; this module's only job is turning that URL into the data
 * URL + pixel dimensions jsPDF needs, with graceful failure (a report card
 * should still generate correctly with no photo/logo if the image fails to
 * load — a network hiccup fetching one student's passport photo mid-batch
 * must not abort the whole print run).
 */

export interface LoadedImage {
  dataUrl: string
  width: number
  height: number
  format: 'JPEG' | 'PNG' | 'WEBP'
}

/**
 * Fetches an image URL and converts it to a data URL + pixel dimensions.
 * Returns null on ANY failure (network error, non-image response, decode
 * failure) rather than throwing — callers treat a null return as "draw
 * without this image," not as an error to surface to the user, since a
 * missing/broken logo or photo is a display gap, not a data-integrity
 * problem worth interrupting a print job over.
 */
export async function loadImageForPdf(url: string | null | undefined): Promise<LoadedImage | null> {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()

    const format = detectFormat(blob.type)
    if (!format) return null

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })

    const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => reject(new Error('image decode failed'))
      img.src = dataUrl
    })

    if (dims.width === 0 || dims.height === 0) return null

    return { dataUrl, width: dims.width, height: dims.height, format }
  } catch {
    return null
  }
}

function detectFormat(mimeType: string): LoadedImage['format'] | null {
  if (mimeType.includes('png')) return 'PNG'
  if (mimeType.includes('webp')) return 'WEBP'
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'JPEG'
  return null
}

/**
 * Computes draw dimensions (mm) that fit an image inside a maxW×maxH box
 * without distorting its aspect ratio — used for the logo and passport
 * photo, which arrive at arbitrary resolutions/aspect ratios (a school
 * might upload a square logo, a wide banner-style logo, or a portrait
 * passport photo) and must all fit cleanly into a fixed-size header slot.
 */
export function fitWithinBox(
  img: { width: number; height: number },
  maxW: number,
  maxH: number,
): { w: number; h: number } {
  const scale = Math.min(maxW / img.width, maxH / img.height)
  return { w: img.width * scale, h: img.height * scale }
}
