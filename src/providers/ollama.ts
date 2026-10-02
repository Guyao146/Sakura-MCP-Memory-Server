import { z } from 'zod';
import type { AiProvider, ExtractedMemory } from './types.js';
import { providerRequest } from './request.js';

const memoriesSchema = z.object({ memories: z.array(z.object({ type: z.enum(['fact','preference','event','task','person','project','summary','document','idea','other']), content: z.string().min(1), summary: z.string(), tags: z.array(z.string()), importance: z.number().min(0).max(1), confidence: z.number().min(0).max(1) })) });

export class OllamaProvider implements AiProvider {
  constructor(private readonly baseUrl: string, private readonly chatModel?: string, private readonly embeddingModel?: string) {}
  async embed(texts: string[], model = this.embeddingModel, signal?: AbortSignal): Promise<number[][]> {
    if (!model) throw new Error('Ollama embedding model is not configured.');
    return providerRequest(`${this.baseUrl}/api/embed`, { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ model, input:texts }) }, 120_000, async response => {
      if (!response.ok) throw new Error(`Ollama embedding request failed (${response.status}).`);
      return ((await response.json()) as { embeddings:number[][] }).embeddings;
    }, signal);
  }
  async extractMemories(text: string, model = this.chatModel, signal?: AbortSignal): Promise<ExtractedMemory[]> {
    if (!model) throw new Error('Ollama chat model is not configured.');
    const prompt = `Extract only durable long-term memories without inventing facts. Return JSON {"memories":[{"type":"fact|preference|event|task|person|project|summary|document|idea|other","content":"...","summary":"...","tags":[],"importance":0.5,"confidence":0.8}]} from:\n${text}`;
    return providerRequest(`${this.baseUrl}/api/chat`, { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ model, stream:false, format:'json', messages:[{role:'user',content:prompt}] }) }, 120_000, async response => {
      if (!response.ok) throw new Error(`Ollama extraction request failed (${response.status}).`);
      const body = await response.json() as { message:{content:string} };
      return memoriesSchema.parse(JSON.parse(body.message.content)).memories;
    }, signal);
  }
}