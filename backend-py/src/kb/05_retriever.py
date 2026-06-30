"""检索器 —— Atlas 向量搜索 + 应用层余弦相似度降级。"""

import logging
import math
import time
from typing import List, Tuple
from langchain_core.documents import Document
from src.config import settings
from src.utils.llm import embeddings
from importlib import import_module

get_kb_collection = import_module("src.kb.03_vector_store").get_kb_collection

logger = logging.getLogger(__name__)

VECTOR_SEARCH_NUM_CANDIDATE_MULTIPLIER = 20
VECTOR_SEARCH_FALLBACK_TTL_MS = 5 * 60 * 1000
_atlas_vector_search_disabled_until = 0


def _cosine_similarity(a: list, b: list) -> float:
    """计算余弦相似度。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if not norm_a or not norm_b:
        return 0.0
    return dot / (norm_a * norm_b)


def _score_to_confidence(scores: List[float]) -> float:
    """取最大分数，限制在 [0, 1]，保留 2 位小数。"""
    finite = [s for s in scores if math.isfinite(s)]
    if not finite:
        return 0.0
    max_score = max(finite)
    bounded = max(0.0, min(1.0, max_score))
    return round(bounded, 2)


def _atlas_score_to_cosine(score: float) -> float:
    """Atlas 分数归一化到 [-1, 1]。"""
    if not math.isfinite(score):
        return 0.0
    normalized = max(0.0, min(1.0, score))
    return normalized * 2 - 1


def _chunk_to_document(chunk: dict) -> Document:
    """将存储的 chunk 转换为 LangChain Document。"""
    text = chunk.get("text", "")
    if not isinstance(text, str):
        text = ""
    metadata = chunk.get("metadata", {}) or {}
    source = chunk.get("source") or metadata.get("source", "unknown_source")
    chunk_id = chunk.get("chunkId", metadata.get("chunkId", 0))

    return Document(
        page_content=text,
        metadata={**metadata, "source": source, "chunkId": chunk_id},
    )


def _build_result(results: List[Tuple[Document, float]]) -> dict:
    """构建检索结果。"""
    if not results:
        return {"docs": [], "confidence": 0.0}

    scores = [s for _, s in results]
    confidence = _score_to_confidence(scores)
    relevant = [
        (doc, s) for doc, s in results
        if math.isfinite(s) and s >= settings.RETRIEVAL_MIN_SCORE
    ]

    if not relevant:
        return {"docs": [], "confidence": confidence}

    return {"docs": [doc for doc, _ in relevant], "confidence": confidence}


def _is_vector_search_config_error(error: Exception) -> bool:
    """判断是否为 Atlas 向量搜索配置错误。"""
    msg = str(error).lower()
    return any(
        kw in msg
        for kw in ["$vectorsearch", "vector search", "vectorsearch", settings.KB_VECTOR_INDEX_NAME.lower()]
    )


def _is_atlas_temporarily_disabled() -> bool:
    """检查 Atlas 是否在临时禁用期内。"""
    return time.time() * 1000 < _atlas_vector_search_disabled_until


def _disable_atlas_temporarily():
    """临时禁用 Atlas 5 分钟。"""
    global _atlas_vector_search_disabled_until
    _atlas_vector_search_disabled_until = time.time() * 1000 + VECTOR_SEARCH_FALLBACK_TTL_MS


async def _retrieve_with_app_cosine(query_embedding: list, k: int = 5) -> dict:
    """应用层余弦相似度检索（全量加载后计算）。"""
    collection = await get_kb_collection()

    stored = await collection.find(
        {
            "text": {"$type": "string"},
            "embedding": {"$type": "array"},
        },
        {
            "projection": {
                "text": 1,
                "embedding": 1,
                "source": 1,
                "chunkId": 1,
                "metadata": 1,
            },
        },
    ).to_list()

    results = []
    for chunk in stored:
        emb = chunk.get("embedding", [])
        if not isinstance(emb, list):
            emb = []
        score = _cosine_similarity(query_embedding, emb)
        doc = _chunk_to_document(chunk)
        if doc.page_content.strip():
            results.append((doc, score))

    results.sort(key=lambda x: x[1], reverse=True)
    return _build_result(results[:k])


async def _retrieve_with_atlas_vector_search(query_embedding: list, k: int = 5) -> dict:
    """MongoDB Atlas 向量搜索。"""
    collection = await get_kb_collection()
    is_local = getattr(collection, "isLocalKbCollection", False)
    num_candidates = max(
        settings.VECTOR_SEARCH_NUM_CANDIDATES,
        k * VECTOR_SEARCH_NUM_CANDIDATE_MULTIPLIER,
    )

    pipeline = [
        {
            "$vectorSearch": {
                "index": settings.KB_VECTOR_INDEX_NAME,
                "path": "embedding",
                "queryVector": query_embedding,
                "numCandidates": num_candidates,
                "limit": k,
            }
        },
        {
            "$project": {
                "text": 1,
                "source": 1,
                "chunkId": 1,
                "metadata": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]

    stored = await collection.aggregate(pipeline).to_list()

    results = []
    for chunk in stored:
        if is_local:
            # 本地存储已输出 [0,1] 归一化分数（与 Atlas 一致），无需再转换
            score = chunk.get("score", 0)
        else:
            score = _atlas_score_to_cosine(chunk.get("score", 0))
        doc = _chunk_to_document(chunk)
        if doc.page_content.strip():
            results.append((doc, score))

    return _build_result(results)


async def retrieve_relevant_chunks(query: str, k: int = 5) -> dict:
    """检索相关文档 chunks。

    Returns:
        {"docs": list[Document], "confidence": float}
    """
    if not query.strip():
        return {"docs": [], "confidence": 0.0}

    query_embedding = await embeddings.aembed_query(query)

    if settings.RETRIEVAL_BACKEND == "app_cosine":
        return await _retrieve_with_app_cosine(query_embedding, k)

    if _is_atlas_temporarily_disabled():
        return await _retrieve_with_app_cosine(query_embedding, k)

    try:
        return await _retrieve_with_atlas_vector_search(query_embedding, k)
    except Exception as e:
        if not _is_vector_search_config_error(e):
            _disable_atlas_temporarily()
            logger.warning(
                f"[retriever] Atlas vector search error, falling back to app_cosine for "
                f"{VECTOR_SEARCH_FALLBACK_TTL_MS / 1000}s. {e}"
            )
            return await _retrieve_with_app_cosine(query_embedding, k)

        _disable_atlas_temporarily()
        logger.warning(
            f"[retriever] Atlas Vector Search is unavailable; falling back to app_cosine for "
            f"{VECTOR_SEARCH_FALLBACK_TTL_MS / 1000}s. {e}"
        )
        return await _retrieve_with_app_cosine(query_embedding, k)
