import { extractText, getDocumentProxy } from 'unpdf';

export async function extractPdfText(buffer: Uint8Array): Promise<{ text: string; pages: string[] }> {
  const pdf = await getDocumentProxy(buffer);
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const merged = pages.join('\n\n');
  void totalPages;
  return { text: merged, pages };
}
