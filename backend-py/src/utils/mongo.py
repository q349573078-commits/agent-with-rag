"""MongoDB 连接管理 —— 懒加载单例。"""

import logging
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError
from src.config import settings

logger = logging.getLogger(__name__)

_client: MongoClient | None = None


def get_mongo_client() -> MongoClient:
    """懒加载单例 MongoClient。"""
    global _client
    if _client is None:
        _client = MongoClient(
            settings.MONGODB_ATLAS_URI,
            serverSelectionTimeoutMS=10000,
            socketTimeoutMS=20000,
        )
    return _client


def get_db():
    """获取 MongoDB 数据库实例。"""
    return get_mongo_client()[settings.MONGODB_DB_NAME]


def is_mongo_connection_error(error: Exception) -> bool:
    """判断是否为 MongoDB 连接错误。"""
    if isinstance(error, (ConnectionFailure, ServerSelectionTimeoutError)):
        return True
    msg = str(error).lower()
    return any(kw in msg for kw in ("connection refused", "timeout", "dns", "econnrefused"))
