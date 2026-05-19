export interface KBChunk {
  source: string;
  chunkId: number;
  text: string;
  embedding: number[];
}

export interface KBFileRecord {
  originalName: string;
  normalizedName: string;
  sha256?: string;
  uploadedAt: Date;
  chunkCount: number;
}
