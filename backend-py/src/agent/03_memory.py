"""对话历史管理 —— MongoDB + 内存回退。"""

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from src.config import settings
from src.utils.mongo import get_mongo_client, get_db

logger = logging.getLogger(__name__)

# 内存回退存储
_memory_conversations: Dict[str, dict] = {}
_use_in_memory = False
_conv_collection = None

CONVERSATIONS_COLLECTION = "conversations"


async def _init_conversations_collection():
    """初始化 conversations 集合。"""
    global _use_in_memory, _conv_collection

    if _use_in_memory:
        raise RuntimeError("Conversation history is using in-memory fallback")

    if _conv_collection is not None:
        return _conv_collection

    try:
        client = get_mongo_client()
        client.admin.command("ping")
        db = get_db()
        col = db[CONVERSATIONS_COLLECTION]
        await col.create_index("threadId", unique=True)
        _conv_collection = col
        return col
    except Exception as e:
        _use_in_memory = True
        _conv_collection = None
        logger.warning(f"[memory] 降级到内存对话历史: {e}")
        raise


async def ensure_thread_id(thread_id: Optional[str] = None) -> str:
    """确保 threadId 存在，不存在则创建新的。"""
    import uuid

    if _use_in_memory:
        if thread_id and thread_id in _memory_conversations:
            return thread_id
        new_id = thread_id or str(uuid.uuid4())[:12]
        _memory_conversations[new_id] = {
            "threadId": new_id,
            "messages": [],
            "createdAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }
        return new_id

    try:
        col = await _init_conversations_collection()
    except Exception:
        return await ensure_thread_id(thread_id)

    if thread_id:
        existing = await col.find_one({"threadId": thread_id})
        if existing:
            return thread_id

    new_id = thread_id or str(uuid.uuid4())[:12]
    now = datetime.now(timezone.utc)
    await col.insert_one({
        "threadId": new_id,
        "messages": [],
        "createdAt": now,
        "updatedAt": now,
    })
    return new_id


async def get_history(thread_id: str) -> List[dict]:
    """获取对话历史。"""
    if _use_in_memory:
        conv = _memory_conversations.get(thread_id)
        if not conv:
            return []
        return [
            {"role": m["role"], "content": m["content"]}
            for m in conv.get("messages", [])
        ]

    try:
        col = await _init_conversations_collection()
    except Exception:
        return await get_history(thread_id)

    conv = await col.find_one({"threadId": thread_id})
    if not conv:
        return []
    return [
        {"role": m["role"], "content": m["content"]}
        for m in conv.get("messages", [])
    ]


async def append_to_history(thread_id: str, *messages: dict) -> None:
    """追加消息到对话历史。"""
    if not messages:
        return

    msgs = [
        {
            "role": m.get("role", "user"),
            "content": m.get("content", ""),
            "ts": m.get("ts", datetime.now(timezone.utc)),
        }
        for m in messages
    ]

    if _use_in_memory:
        existing = _memory_conversations.get(
            thread_id,
            {
                "threadId": thread_id,
                "messages": [],
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            },
        )
        existing["messages"].extend(msgs)
        existing["updatedAt"] = datetime.now(timezone.utc)
        _memory_conversations[thread_id] = existing
        return

    try:
        col = await _init_conversations_collection()
    except Exception:
        await append_to_history(thread_id, *messages)
        return

    await col.update_one(
        {"threadId": thread_id},
        {
            "$push": {"messages": {"$each": msgs}},
            "$set": {"updatedAt": datetime.now(timezone.utc)},
        },
    )
