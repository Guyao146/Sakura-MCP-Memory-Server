export type SpaceRole = 'owner' | 'admin' | 'editor' | 'contributor' | 'viewer';
export type MemoryType = 'fact' | 'preference' | 'event' | 'task' | 'person' | 'project' | 'summary' | 'document' | 'idea' | 'other';
export type MemoryStatus = 'active' | 'pending_confirmation' | 'superseded' | 'archived' | 'deleted';

export interface MemoryRecord {
  id: string; space_id: string; type: MemoryType; content: string; summary: string; tags: string[];
  importance: number; confidence: number; sensitivity: number; status: MemoryStatus;
  valid_from: string | null; valid_until: string | null; expires_at: string | null;
  created_by: string; created_at: string; updated_at: string; embedding_revision: string;
}

export interface RememberInput {
  spaceId: string; type: MemoryType; content: string; summary?: string; tags?: string[];
  importance?: number; confidence?: number; sensitivity?: number; validFrom?: string; validUntil?: string; expiresAt?: string;
  status?: Exclude<MemoryStatus,'deleted'>;
  sources?: Array<{ type: string; uri?: string; agent?: string; excerpt?: string; metadata?: Record<string, unknown> }>;
  source?: { type: string; uri?: string; agent?: string; excerpt?: string; metadata?: Record<string, unknown> };
}
