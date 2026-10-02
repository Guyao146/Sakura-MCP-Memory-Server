import { z } from 'zod';
import type { AiProvider, ExtractedMemory } from './types.js';
import { providerRequest } from './request.js';

const extractedSchema = z.object({ memories: z.array(z.object({
  type: z.enum(['fact','preference','event','task','person','project','summary','document','idea','other']),
  content: z.string().min(1), summary: z.string(), tags: z.array(z.string()),
  importance: z.number().min(0).max(1), confidence: z.number().min(0).max(1)
})) });

export class OpenAICompatibleProvider implements AiProvider {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string, private readonly chatModel?: string, private readonly embeddingModel?: string) {}
  private headers() { return { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) }; }
  async embed(texts: string[], model = this.embeddingModel, signal?: AbortSignal): Promise<number[][]> {
    if (!model) throw new Error('OpenAI-compatible embedding model is not configured.');
    return providerRequest(`${this.baseUrl}/embeddings`, { method: 'POST', headers: this.headers(),
      body: JSON.stringify({ model, input: texts }) }, 60_000, async response => {
      if (!response.ok) throw new Error(`Embedding request failed (${response.status})${await describeUpstreamError(response)}.`);
      const body = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
      return body.data.sort((a,b) => a.index-b.index).map(item => item.embedding);
    }, signal);
  }
  async extractMemories(text: string, model = this.chatModel, signal?: AbortSignal): Promise<ExtractedMemory[]> {
    if (!model) throw new Error('OpenAI-compatible chat model is not configured.');
    return providerRequest(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify({
      model, temperature: 0, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: 'Extract only durable, useful long-term memories. Return JSON: {"memories":[{"type":"fact|preference|event|task|person|project|summary|document|idea|other","content":"...","summary":"...","tags":[],"importance":0.5,"confidence":0.8}]}. Do not invent facts.' },
        { role: 'user', content: text }
      ] }) }, 120_000, async response => {
      if (!response.ok) throw new Error(`Memory extraction request failed (${response.status})${await describeUpstreamError(response)}.`);
      const body = await response.json() as { choices: Array<{ message: { content: string } }> };
      return extractedSchema.parse(JSON.parse(body.choices[0]?.message.content ?? '{}')).memories;
    }, signal);
  }
}

async function describeUpstreamError(response: Response): Promise<string> {
  let raw = '';
  try { raw = (await response.text()).slice(0, 500); }
  catch { return ''; }
  if (!raw.trim()) return '';
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const err = parsed.error;
    const message = typeof err === 'string' ? err
      : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message
      : typeof parsed.message === 'string' ? parsed.message : undefined;
    if (message) detail = message;
  } catch { /* keep raw text */ }
  return `：${detail.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`;
}
