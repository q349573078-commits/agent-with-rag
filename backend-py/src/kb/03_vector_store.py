"""向量存储抽象层 —— MongoDB Atlas + 本地 JSON 降级。"""

import logging
from src.config import settings
from src.utils.llm import embeddings
from src.utils.mongo import get_db, is_mongo_connection_error
from src.kb.local_store import get_local_kb_collection

logger = logging.getLogger(__name__)

KB_COLLECTION_NAME = "kb_chunks"
KB_FILES_COLLECTION_NAME = "kb_files"

_collection_promise = None
_files_collection_promise = None
_vector_store_promise = None


async def _get_mongo_collection_or_local(mongo_name, local_name):
    """MongoDB 连接失败时降级到本地 JSON 存储。"""
    try:
        db = get_db()
        return db[mongo_name]
    except Exception as e:
        if not is_mongo_connection_error(e):
            raise
        logger.warning(
            f"[kb] MongoDB is unavailable; using local file store for {local_name}. {e}"
        )
        return get_local_kb_collection(local_name)


async def get_kb_collection():
    """获取 kb_chunks 集合（懒加载单例）。"""
    global _collection_promise
    if _collection_promise is None:
        async def _init():
            return await _get_mongo_collection_or_local(KB_COLLECTION_NAME, "kb_chunks")
        _collection_promise = _init()
    return await _collection_promise


async def get_kb_files_collection():
    """获取 kb_files 集合（懒加载单例，自动建索引）。"""
    global _files_collection_promise
    if _files_collection_promise is None:
        async def _init():
            col = await _get_mongo_collection_or_local(
                KB_FILES_COLLECTION_NAME, "kb_files"
            )
            # 创建索引（对齐 TS）
            try:
                await col.create_index(
                    {"sha256": 1},
                    name="uniq_sha256",
                    unique=True,
                    partialFilterExpression={
                        "sha256": {"$exists": True, "$type": "string"}
                    },
                )
            except Exception:
                pass
            try:
                await col.create_index(
                    {"normalizedName": 1}, name="idx_normalizedName"
                )
            except Exception:
                pass
            try:
                await col.create_index(
                    {"uploadedAt": -1}, name="idx_uploadedAt"
                )
            except Exception:
                pass
            return col
        _files_collection_promise = _init()
    return await _files_collection_promise


async def get_vector_store():
    """获取 MongoDBAtlasVectorSearch 实例（懒加载单例）。"""
    global _vector_store_promise
    if _vector_store_promise is None:
        async def _init():
            from langchain_mongodb import MongoDBAtlasVectorSearch
            col = await get_kb_collection()
            return MongoDBAtlasVectorSearch(
                embedding=embeddings,
                collection=col,
                index_name=settings.KB_VECTOR_INDEX_NAME,
                text_key="text",
                embedding_key="embedding",
            )
        _vector_store_promise = _init()
    return await _vector_store_promise
