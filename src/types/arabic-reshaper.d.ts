/**
 * arabic-reshaper ships no TypeScript types (plain CommonJS UMD module).
 * Minimal ambient declaration for the one function reportCardPdf.ts uses.
 */
declare module 'arabic-reshaper' {
  const ArabicReshaper: {
    /** Converts standalone Arabic letters to their contextual (isolated/
     *  initial/medial/final) presentation-form codepoints. Non-Arabic
     *  characters pass through unchanged. */
    convertArabic(input: string): string
    convertArabicBack(input: string): string
  }
  export default ArabicReshaper
}
