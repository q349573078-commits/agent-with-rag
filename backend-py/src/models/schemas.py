"""Pydantic 请求/响应数据模型。"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------
# Agent 对话
# ---------------------------------------------------------------
class ChatRequest(BaseModel):
    message: Optional[str] = Field(None, description="用户消息")
    threadId: Optional[str] = Field(None, description="会话线程 ID")
    webSearchDecision: Optional[str] = Field(
        None, pattern="^(confirm|cancel)$", description="联网搜索确认: confirm / cancel"
    )


class AgentCitation(BaseModel):
    source: str
    preview: str
    url: Optional[str] = None
    type: Optional[str] = None  # "kb" | "web"


class PendingWebSearchInterrupt(BaseModel):
    type: str = "web_search_confirmation"
    threadId: str
    message: str
    question: str
    reason: str
    confidence: Optional[float] = None
    confirmLabel: str = "确定"
    cancelLabel: str = "取消"


# ---------------------------------------------------------------
# 知识库
# ---------------------------------------------------------------
class KBFileInfo(BaseModel):
    id: Optional[str] = None
    name: str
    uploadedAt: Optional[datetime] = None
    chunkCount: Optional[int] = None
    sha256: Optional[str] = None
    legacy: Optional[bool] = None


class KBFilesResponse(BaseModel):
    ok: bool = True
    files: List[KBFileInfo] = []
    legacy: Optional[bool] = None


class KBExistsResponse(BaseModel):
    ok: bool = True
    exists: bool
    matchBy: Optional[str] = None
    file: Optional[dict] = None
    legacy: Optional[bool] = None


class KBUploadResponse(BaseModel):
    ok: bool = True
    skipped: Optional[bool] = None
    reason: Optional[str] = None
    matchBy: Optional[str] = None
    file: Optional[dict] = None
    totalChunks: Optional[int] = None
    sources: Optional[List[str]] = None


class KBDeleteResponse(BaseModel):
    ok: bool = True
    deleted: Optional[dict] = None
    notFound: Optional[bool] = None


class KBHealthResponse(BaseModel):
    ok: bool = True
    mongo: Optional[dict] = None
    storage: Optional[dict] = None
    embedding_model: str = "unknown"
    reranker: str = "unknown"
    vector_store: str = "unknown"


class KBChunk(BaseModel):
    id: Optional[str] = None
    text: str
    embedding: Optional[List[float]] = None
    source: str
    chunkId: int
    metadata: Dict[str, Any] = Field(default_factory=dict)


class KBFileRecord(BaseModel):
    originalName: str
    normalizedName: str
    sha256: Optional[str] = None
    uploadedAt: datetime = Field(default_factory=datetime.utcnow)
    chunkCount: int = 0
