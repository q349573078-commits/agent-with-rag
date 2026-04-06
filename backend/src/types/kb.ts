export interface KBChunk {
  source: string;
  chunkId: number;
  text: string;
  embedding: number[];
}
