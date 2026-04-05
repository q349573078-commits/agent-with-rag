export interface KBChunk {
  // policy.pdf
  source: string;

  chunkId: number;

  text: string;

  //store in mongo atlas for vector search
  // 1536
  embedding: number[];
}

// citation/source

//agentAnaswer
