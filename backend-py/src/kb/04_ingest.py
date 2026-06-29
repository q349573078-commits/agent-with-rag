"""知识库摄入流水线 —— embed + insert。"""

import hashlib
import logging
from typing import List
from langchain_core.documents import Document
from src.utils.llm import embeddings
from importlib import import_module

get_kb_collection = import_module("src.kb.03_vector_store").get_kb_collection

logger = logging.getLogger(__name__)


async def ingest_documents(chunks: List[Document]) -> dict:
    """摄入文档 chunks：生成 embedding → 批量写入向量存储。

    Returns:
        {"ok": bool, "totalChunks": int, "sources": list[str]}
    """
    if not chunks:
        return {"ok": False, "totalChunks": 0, "sources": []}

    collection = await get_kb_collection()
    current_id = 0

    texts = [chunk.page_content for chunk in chunks]
    chunk_embeddings = await embeddings.aembed_documents(texts)

    docs_with_meta = []
    sources_set = set()

    for chunk, emb in zip(chunks, chunk_embeddings):
        source = chunk.metadata.get("source", "unknown_source") if chunk.metadata else "unknown_source"
        sources_set.add(source)
        chunk_id = current_id
        current_id += 1

        docs_with_meta.append({
            "text": chunk.page_content,
            "embedding": emb,
            "source": source,
            "chunkId": chunk_id,
            "metadata": {
                **(chunk.metadata or {}),
                "source": source,
                "chunkId": chunk_id,
            },
        })

    await collection.insert_many(docs_with_meta)

    return {
        "ok": True,
        "totalChunks": len(docs_with_meta),
        "sources": list(sources_set),
    }


def compute_sha256(file_path: str) -> str:
    """计算文件 SHA-256 哈希。"""
    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha.update(chunk)
    return sha.hexdigest()
