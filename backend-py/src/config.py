"""应用配置模块 —— 基于 pydantic-settings 的环境变量管理。"""

from pydantic_settings import BaseSettings
from typing import Literal


class Settings(BaseSettings):
    """从环境变量加载的应用配置。"""

    # 服务端口
    PORT: int = 4000

    # OpenAI
    OPENAI_API_KEY: str = ""

    # Tavily 联网搜索
    TAVILY_API_KEY: str = ""

    # MongoDB
    MONGODB_ATLAS_URI: str = ""
    MONGODB_DB_NAME: str = "agentic-rag"

    # ---------------------------------------------------------------
    # LLM 配置
    # ---------------------------------------------------------------
    LLM_MODEL: str = "gpt-4o-mini"
    LLM_TEMPERATURE: float = 0.2

    # ---------------------------------------------------------------
    # Embedding 配置
    # ---------------------------------------------------------------
    EMBEDDING_MODEL: str = "text-embedding-3-small"

    # ---------------------------------------------------------------
    # 重排序配置
    # ---------------------------------------------------------------
    RERANK_ENABLED: bool = False
    RERANK_CANDIDATES: int = 20
    RERANK_TOP_K: int = 4

    # ---------------------------------------------------------------
    # 检索配置
    # ---------------------------------------------------------------
    RETRIEVAL_BACKEND: Literal["atlas_vector", "app_cosine"] = "atlas_vector"
    RETRIEVAL_MIN_SCORE: float = 0.5
    RETRIEVAL_LOW_CONFIDENCE_THRESHOLD: float = 0.6
    KB_VECTOR_INDEX_NAME: str = "kb_vector_index"
    VECTOR_SEARCH_NUM_CANDIDATES: int = 100

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
        "extra": "ignore",
    }


# 全局单例
settings = Settings()
