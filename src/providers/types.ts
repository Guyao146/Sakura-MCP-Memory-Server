export interface ExtractedMemory {
  type: 'fact' | 'preference' | 'event' | 'task' | 'person' | 'project' | 'summary' | 'document' | 'idea' | 'other';
  content: string; summary: string; tags: string[]; importance: number; confidence: number;
}
export interface AiProvider {
  embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]>;
  extractMemories(text: string, model?: string, signal?: AbortSignal): Promise<ExtractedMemory[]>;
}
