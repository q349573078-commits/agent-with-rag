# backend-py RAG 重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 backend-py 的 RAG、Embedding、Rerank 模块完全对齐 TypeScript backend 的实现方式——去除本地模型，统一 OpenAI API，重构目录结构。

**架构：** 配置层 (config.py) → 模型实例化层 (utils/llm.py) → KB 管道 (kb/01~05) → Agent 状态机 (agent/02_agent.py) → 路由层 (routes/)。MongoDB 降级到本地 JSON 文件存储 (kb/local_store.py)，Atlas 向量搜索降级到应用层余弦相似度 (kb/05_retriever.py)。

**技术栈：** Python 3.11+, FastAPI, LangChain/LangGraph, pymongo, PyMuPDF, Tavily, pydantic-settings

---

### 任务 1：精简配置 `config.py`

**文件：**
- 修改：`backend-py/src/config.py`

- [ ] **步骤 1：重写 `src/config.py`**

移除 BGE/ChromaDB/jieba 相关配置，精简为只包含 OpenAI API 驱动的配置项。新增 `EMBEDDING_MODEL`，移除 `EMBEDDING_BACKEND`、`BGE_MODEL_NAME`、`EMBEDDING_BATCH_SIZE`、`RERANKER_MODEL_NAME`、`VECTOR_STORE`、`CHROMA_PERSIST_DIR`、`CHINESE_SPLITTER_STRATEGY`、`JIEBA_USER_DICT`。数据库名默认值改为 `"agentic-rag"` 对齐 TS。

```python
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
    }


# 全局单例
settings = Settings()
```

- [ ] **步骤 2：验证配置模块可正常导入**

```bash
cd backend-py && python -c "from src.config import settings; print(dict(settings))"
```

预期：打印出所有配置项，无报错。

- [ ] **步骤 3：Commit**

```bash
git add backend-py/src/config.py
git commit -m "refactor(backend-py): simplify config - remove local model settings"
```

---

### 任务 2：新建 `utils/` — 模型实例化与 MongoDB 连接

**文件：**
- 创建：`backend-py/src/utils/__init__.py`
- 创建：`backend-py/src/utils/llm.py`
- 创建：`backend-py/src/utils/mongo.py`

- [ ] **步骤 1：创建 `src/utils/__init__.py`**

```python
# utils 模块
```

- [ ] **步骤 2：创建 `src/utils/llm.py`**

模块级单例，对齐 TS `openai.ts`。四个模型实例：

```python
"""LLM 模型实例化 —— 模块级单例，对齐 TS openai.ts。"""

from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from src.config import settings

# 答案生成（温度稍高，保证自然度）
chat_model = ChatOpenAI(
    model=settings.LLM_MODEL,
    temperature=settings.LLM_TEMPERATURE,
    api_key=settings.OPENAI_API_KEY,
)

# Rerank + 反思（温度=0，保证一致性）
rerank_model = ChatOpenAI(
    model=settings.LLM_MODEL,
    temperature=0,
    api_key=settings.OPENAI_API_KEY,
)

# 查询规划（温度=0）
reflection_model = ChatOpenAI(
    model=settings.LLM_MODEL,
    temperature=0,
    api_key=settings.OPENAI_API_KEY,
)

# Embedding
embeddings = OpenAIEmbeddings(
    model=settings.EMBEDDING_MODEL,
    api_key=settings.OPENAI_API_KEY,
)
```

- [ ] **步骤 3：创建 `src/utils/mongo.py`**

从现有 `rag/vector_store.py` 提取 MongoDB 连接管理，使用 pymongo 同步 client + `serverSelectionTimeoutMS`。

```python
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
    return any(kw in msg for kw in ("connectionrefused", "timeout", "dns", "econnrefused"))
```

- [ ] **步骤 4：验证导入**

```bash
cd backend-py && python -c "
from src.utils.llm import chat_model, rerank_model, reflection_model, embeddings
from src.utils.mongo import get_mongo_client
print('chat_model:', type(chat_model).__name__)
print('embeddings:', type(embeddings).__name__)
print('OK')
"
```

- [ ] **步骤 5：Commit**

```bash
git add backend-py/src/utils/
git commit -m "feat(backend-py): add utils/llm and utils/mongo modules"
```

---

### 任务 3：新建 `kb/local_store.py` — 本地 JSON 存储

**文件：**
- 创建：`backend-py/src/kb/__init__.py`
- 创建：`backend-py/src/kb/local_store.py`

- [ ] **步骤 1：创建 `src/kb/__init__.py`**

```python
# kb 模块
```

- [ ] **步骤 2：创建 `src/kb/local_store.py`**

完整移植 TS `localStore.ts` 到 Python。实现 `LocalKbCollection`（模拟 MongoDB Collection API）和 `LocalCursor`（链式调用）。

关键功能：
- JSON 文件持久化到 `data/kb-local-store.json`
- `find(filter, projection)` → LocalCursor
- `find_one`, `insert_one`, `insert_many`, `update_one`, `delete_one`, `delete_many`
- `count_documents`, `distinct`, `aggregate`（支持 `$vectorSearch`）
- `create_index`（no-op）
- ObjectId 兼容
- 写入队列保证串行持久化
- 过滤条件支持：`$type`, `$exists`, `$ne`, `$or`
- 投影支持：`{field: 1}` / `{field: 0}`

```python
"""本地 JSON 文件存储 —— 模拟 MongoDB Collection API。"""

import json
import logging
import math
import os
from bson import ObjectId
from copy import deepcopy

logger = logging.getLogger(__name__)

LOCAL_STORE_PATH = os.path.join(os.getcwd(), "data", "kb-local-store.json")
EMPTY_DATA = {"kb_chunks": [], "kb_files": []}

_data_promise = None
_write_queue = None  # asyncio 环境下用同步即可


def _ensure_async_support():
    """兼容同步调用。"""
    pass


def _load_data():
    """加载本地存储数据。"""
    global _data_promise
    if _data_promise is not None:
        return _data_promise

    try:
        if os.path.exists(LOCAL_STORE_PATH):
            with open(LOCAL_STORE_PATH, "r", encoding="utf-8") as f:
                parsed = json.load(f)
        else:
            parsed = deepcopy(EMPTY_DATA)
    except Exception:
        logger.warning("[localStore] Failed to load, using empty data")
        parsed = deepcopy(EMPTY_DATA)

    # 反序列化 ObjectId
    for key in ("kb_chunks", "kb_files"):
        for doc in parsed.get(key, []):
            if isinstance(doc.get("_id"), str) and ObjectId.is_valid(doc["_id"]):
                doc["_id"] = ObjectId(doc["_id"])

    _data_promise = parsed
    return parsed


def _persist_data(data):
    """持久化数据到 JSON 文件。"""
    os.makedirs(os.path.dirname(LOCAL_STORE_PATH), exist_ok=True)
    disk_data = deepcopy(data)
    for key in ("kb_chunks", "kb_files"):
        for doc in disk_data.get(key, []):
            if isinstance(doc.get("_id"), ObjectId):
                doc["_id"] = str(doc["_id"])

    with open(LOCAL_STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(disk_data, f, ensure_ascii=False, indent=2, default=str)


def _get_path_value(doc, path):
    """获取嵌套字段值，如 'metadata.source'。"""
    for key in path.split("."):
        if isinstance(doc, dict):
            doc = doc.get(key)
        else:
            return None
    return doc


def _set_path_value(doc, path, value):
    """设置嵌套字段值。"""
    keys = path.split(".")
    for key in keys[:-1]:
        if key not in doc or not isinstance(doc[key], dict):
            doc[key] = {}
        doc = doc[key]
    doc[keys[-1]] = value


def _values_equal(left, right):
    """比较两个值是否相等，兼容 ObjectId。"""
    if isinstance(left, ObjectId):
        return str(left) == str(right) if isinstance(right, (ObjectId, str)) else False
    if isinstance(right, ObjectId):
        return str(left) == str(right) if isinstance(left, (ObjectId, str)) else False
    return left == right


def _matches_type(value, type_str):
    """检查值是否匹配指定 BSON 类型。"""
    if type_str == "array":
        return isinstance(value, list)
    if type_str == "string":
        return isinstance(value, str)
    if type_str == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_str == "date":
        return isinstance(value, (str,))  # simplified
    if type_str == "object":
        return isinstance(value, dict) and not isinstance(value, list)
    return False


def _matches_condition(value, condition):
    """检查值是否匹配条件。支持 $type, $exists, $ne, 等值匹配。"""
    if isinstance(condition, dict) and not isinstance(value, (ObjectId,)):
        for operator, expected in condition.items():
            if operator == "$type":
                if not _matches_type(value, str(expected)):
                    return False
            elif operator == "$exists":
                exists = value is not None
                if exists != bool(expected):
                    return False
            elif operator == "$ne":
                if _values_equal(value, expected):
                    return False
            else:
                return False
        return True

    return _values_equal(value, condition)


def _matches_filter(doc, filter_dict=None):
    """检查文档是否匹配过滤条件。"""
    if not filter_dict:
        return True

    for key, condition in filter_dict.items():
        if key == "$or":
            if not isinstance(condition, list):
                return False
            if not any(_matches_filter(doc, item) for item in condition):
                return False
            continue

        if not _matches_condition(_get_path_value(doc, key), condition):
            return False

    return True


def _apply_projection(doc, projection=None):
    """应用字段投影。"""
    if not projection:
        return deepcopy(doc)

    include_keys = [k for k, v in projection.items() if v == 1]
    if include_keys:
        result = {}
        for key in include_keys:
            val = _get_path_value(doc, key)
            if val is not None:
                _set_path_value(result, key, val)
        if projection.get("_id") != 0 and "_id" in doc:
            result["_id"] = doc["_id"]
        return result

    result = deepcopy(doc)
    for key, v in projection.items():
        if v == 0:
            result.pop(key, None)
    return result


def _cosine_similarity(a, b):
    """计算余弦相似度。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if not norm_a or not norm_b:
        return 0.0
    return dot / (norm_a * norm_b)


class LocalCursor:
    """模拟 MongoDB Cursor 的链式调用。"""

    def __init__(self, docs):
        self._docs = docs if isinstance(docs, list) else list(docs)

    def sort(self, spec):
        """排序，spec 如 {'uploadedAt': -1} 或 [('key', 1)]。"""
        items = list(self._docs)
        if isinstance(spec, dict):
            entries = list(spec.items())
        else:
            entries = spec

        for key, direction in reversed(entries):
            items.sort(
                key=lambda d: _get_path_value(d, key) or "",
                reverse=(direction == -1),
            )
        self._docs = items
        return self

    def limit(self, n):
        """截取前 n 条。"""
        self._docs = self._docs[:n]
        return self

    def to_list(self, length=None):
        """转换为列表。"""
        result = deepcopy(self._docs)
        if length is not None:
            result = result[:length]
        return result

    def __aiter__(self):
        self._idx = 0
        return self

    async def __anext__(self):
        if self._idx >= len(self._docs):
            raise StopAsyncIteration
        item = self._docs[self._idx]
        self._idx += 1
        return item


class LocalKbCollection:
    """本地 JSON 文件存储，模拟 MongoDB Collection API。"""

    isLocalKbCollection = True

    def __init__(self, name):
        self._name = name  # "kb_chunks" or "kb_files"

    # --- 索引 ---
    async def create_index(self, keys, **kwargs):
        return kwargs.get("name", "local_index")

    # --- 查询 ---
    def find(self, filter_dict=None, projection=None):
        data = _load_data()
        docs = [
            _apply_projection(doc, projection)
            for doc in data[self._name]
            if _matches_filter(doc, filter_dict)
        ]
        return LocalCursor(docs)

    async def find_one(self, filter_dict=None, projection=None):
        docs = self.find(filter_dict, projection).limit(1).to_list()
        return docs[0] if docs else None

    # --- 写入 ---
    async def insert_one(self, doc):
        data = _load_data()
        doc = deepcopy(doc)
        if "_id" not in doc:
            doc["_id"] = ObjectId()
        data[self._name].append(doc)
        _persist_data(data)
        return type("Result", (), {"acknowledged": True, "inserted_id": doc["_id"]})()

    async def insert_many(self, docs):
        data = _load_data()
        result_docs = []
        for doc in docs:
            doc = deepcopy(doc)
            if "_id" not in doc:
                doc["_id"] = ObjectId()
            result_docs.append(doc)
        data[self._name].extend(result_docs)
        _persist_data(data)
        return type("Result", (), {"acknowledged": True, "inserted_count": len(docs)})()

    async def update_one(self, filter_dict, update):
        data = _load_data()
        for doc in data[self._name]:
            if _matches_filter(doc, filter_dict):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_path_value(doc, k, v)
                if "$push" in update:
                    push_data = update["$push"]
                    for k, v in push_data.items():
                        arr = _get_path_value(doc, k) or []
                        if "$each" in v:
                            arr.extend(v["$each"])
                        else:
                            arr.append(v)
                        _set_path_value(doc, k, arr)
                _persist_data(data)
                return type("Result", (), {
                    "acknowledged": True,
                    "matched_count": 1,
                    "modified_count": 1,
                })()
        return type("Result", (), {
            "acknowledged": True,
            "matched_count": 0,
            "modified_count": 0,
        })()

    async def delete_one(self, filter_dict):
        data = _load_data()
        for i, doc in enumerate(data[self._name]):
            if _matches_filter(doc, filter_dict):
                data[self._name].pop(i)
                _persist_data(data)
                return type("Result", (), {"acknowledged": True, "deleted_count": 1})()
        return type("Result", (), {"acknowledged": True, "deleted_count": 0})()

    async def delete_many(self, filter_dict):
        data = _load_data()
        before = len(data[self._name])
        data[self._name] = [d for d in data[self._name] if not _matches_filter(d, filter_dict)]
        deleted = before - len(data[self._name])
        if deleted > 0:
            _persist_data(data)
        return type("Result", (), {"acknowledged": True, "deleted_count": deleted})()

    # --- 聚合 ---
    async def count_documents(self, filter_dict=None):
        data = _load_data()
        return sum(1 for d in data[self._name] if _matches_filter(d, filter_dict))

    async def distinct(self, field):
        data = _load_data()
        values = set()
        for doc in data[self._name]:
            val = _get_path_value(doc, field)
            if val is not None:
                if isinstance(val, (str, int, float)):
                    values.add(val)
                else:
                    values.add(str(val))
        return list(values)

    def aggregate(self, pipeline):
        """支持 $vectorSearch 聚合管道。"""
        data = _load_data()

        vector_search = None
        project = None
        for stage in pipeline:
            if "$vectorSearch" in stage:
                vector_search = stage["$vectorSearch"]
            if "$project" in stage:
                project = stage["$project"]

        if not vector_search:
            return LocalCursor([])

        query_vector = vector_search.get("queryVector", [])
        limit = vector_search.get("limit", 5)

        results = []
        for doc in data[self._name]:
            if not isinstance(doc.get("text"), str):
                continue
            emb = doc.get("embedding")
            if not isinstance(emb, list) or not emb:
                continue

            score = _cosine_similarity(query_vector, emb)
            # 归一化到 [0, 1]
            normalized_score = (max(-1.0, min(1.0, score)) + 1) / 2
            doc_copy = deepcopy(doc)
            doc_copy["score"] = normalized_score
            results.append(doc_copy)

        results.sort(key=lambda d: d["score"], reverse=True)
        results = results[:limit]

        if project:
            results = [_apply_projection(doc, project) for doc in results]

        return LocalCursor(results)


# ---- 预创建实例 ----
_kb_chunks = LocalKbCollection("kb_chunks")
_kb_files = LocalKbCollection("kb_files")


def get_local_kb_collection(name):
    """获取本地存储集合。"""
    if name == "kb_chunks":
        return _kb_chunks
    elif name == "kb_files":
        return _kb_files
    raise ValueError(f"Unknown collection: {name}")


def is_local_kb_collection(collection):
    """检查是否为本地存储集合。"""
    return getattr(collection, "isLocalKbCollection", False)
```

- [ ] **步骤 3：验证 local_store 基本操作**

```bash
cd backend-py && python -c "
from src.kb.local_store import get_local_kb_collection
import asyncio

async def test():
    col = get_local_kb_collection('kb_chunks')
    # insert
    r = await col.insert_one({'text': 'hello', 'source': 'test', 'chunkId': 0})
    print('insert:', r.inserted_id)
    # count
    cnt = await col.count_documents({'source': 'test'})
    print('count:', cnt)
    # find
    docs = col.find({'source': 'test'}).to_list()
    print('found:', len(docs))
    # cleanup
    await col.delete_many({'source': 'test'})
    print('cleaned up')
    print('OK')

asyncio.run(test())
"
```

预期：insert/count/find/delete 均正常，输出 OK。

- [ ] **步骤 4：Commit**

```bash
git add backend-py/src/kb/__init__.py backend-py/src/kb/local_store.py
git commit -m "feat(backend-py): add local JSON store (kb/local_store.py)"
```

---

### 任务 4：新建 `kb/03_vector_store.py` — 向量存储抽象层

**文件：**
- 创建：`backend-py/src/kb/03_vector_store.py`

- [ ] **步骤 1：创建 `src/kb/03_vector_store.py`**

对齐 TS `03_vectorStore.ts`。提供 `get_kb_collection()`、`get_kb_files_collection()`、`get_vector_store()`。MongoDB 连接失败时自动降级到 `LocalKbCollection`。

注意表名：`kb_chunks` 和 `kb_files`（对齐 TS，不是原来的 `conversations`）。

```python
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
```

- [ ] **步骤 2：验证导入和基本连接**

```bash
cd backend-py && python -c "
import asyncio
async def test():
    from src.kb[03_vector_store](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/03_vector_store.py) import get_kb_collection, get_kb_files_collection
    col = await get_kb_collection()
    print('kb_collection type:', type(col).__name__)
    files_col = await get_kb_files_collection()
    print('files_collection type:', type(files_col).__name__)
    print('OK')
asyncio.run(test())
"
```

预期：打印 collection 类型（MongoDB Collection 或 LocalKbCollection），无报错。

- [ ] **步骤 3：Commit**

```bash
git add backend-py/src/kb/03_vector_store.py
git commit -m "feat(backend-py): add vector store abstraction (kb/03_vector_store.py)"
```

---

### 任务 5：创建 `kb/01_loaders.py` — 文档加载器

**文件：**
- 创建：`backend-py/src/kb/01_loaders.py`

- [ ] **步骤 1：创建 `src/kb/01_loaders.py`**

从 `rag/loaders.py` 迁移，但简化：
- PDF：使用 `fitz` (PyMuPDF) 整篇读取（非按页，对齐 TS）
- TXT/Markdown：UTF-8 直接读取，去掉 chardet 编码检测
- 统一入口 `load_file_as_documents(file_path, mime_type, original_name)`

```python
"""文档加载器 —— PyMuPDF + UTF-8。"""

import os
from typing import List
from langchain_core.documents import Document


def _get_ext(name: str) -> str:
    idx = name.rfind(".")
    return name[idx + 1 :].lower() if idx != -1 else ""


async def load_pdf(file_path: str, original_name: str) -> List[Document]:
    """使用 PyMuPDF 加载 PDF，整篇读取。"""
    import fitz

    doc = fitz.open(file_path)
    total_pages = len(doc)

    texts = []
    for page_num in range(total_pages):
        page = doc.load_page(page_num)
        text = page.get_text()
        if text and text.strip():
            texts.append(text.strip())

    doc.close()

    full_text = "\n\n".join(texts)
    if not full_text.strip():
        return []

    return [
        Document(
            page_content=full_text,
            metadata={
                "source": original_name,
                "totalPages": total_pages,
            },
        )
    ]


async def load_text_or_markdown(file_path: str, original_name: str) -> List[Document]:
    """加载 TXT 或 Markdown 文件，UTF-8 编码。"""
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()

    text = text.strip()
    if not text:
        return []

    return [
        Document(
            page_content=text,
            metadata={"source": original_name},
        )
    ]


async def load_file_as_documents(
    file_path: str,
    mime_type: str,
    original_name: str,
) -> List[Document]:
    """统一入口：根据 MIME 类型或扩展名加载文档。"""
    ext = _get_ext(original_name)

    is_pdf = mime_type == "application/pdf" or ext == "pdf"
    is_markdown = mime_type == "text/markdown" or ext in ("md", "markdown")
    is_text = mime_type == "text/plain" or ext == "txt"

    if is_pdf:
        return await load_pdf(file_path, original_name)
    elif is_text or is_markdown:
        return await load_text_or_markdown(file_path, original_name)
    else:
        raise ValueError(f"不支持的文件格式: {mime_type} ({ext})")
```

- [ ] **步骤 2：Commit**

```bash
git add backend-py/src/kb/01_loaders.py
git commit -m "feat(backend-py): add document loaders (kb/01_loaders.py)"
```

---

### 任务 6：创建 `kb/02_splitter.py` — 文本分割器

**文件：**
- 创建：`backend-py/src/kb/02_splitter.py`

- [ ] **步骤 1：创建 `src/kb/02_splitter.py`**

对齐 TS `02_splitter.ts`。纯 `RecursiveCharacterTextSplitter`，自适应 chunk 策略。**不使用 jieba**。

关键：
- 根据 source 后缀判断类型（markdown/pdf/text）
- 按文档类型使用不同分隔符
- 短文档（≤500 字符）不分块
- 自适应 chunk_size/chunk_overlap
- `normalize_chunk` 清理多余空行
- metadata 带 `_sourceType`, `_splitStrategy`, `_chunkSize`, `_chunkOverlap`, `_chunkIndex`

```python
"""中文文本分割器 —— 纯 RecursiveCharacterTextSplitter，自适应策略。"""

from typing import List
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

DEFAULT_CHUNK_SIZE = 800
DEFAULT_CHUNK_OVERLAP = 120
SHORT_DOC_THRESHOLD = 500
LARGE_DOC_THRESHOLD = 4000
HUGE_DOC_THRESHOLD = 12000


def _get_source_type(source) -> str:
    """根据文件名判断文档类型。"""
    name = str(source).lower() if source else ""
    if name.endswith(".md") or name.endswith(".markdown"):
        return "markdown"
    if name.endswith(".pdf"):
        return "pdf"
    return "text"


def _get_separators(source_type: str) -> List[str]:
    """根据文档类型返回分隔符优先级。"""
    common = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "；", ";", "，", ",", " ", ""]

    if source_type == "markdown":
        return [
            "\n# ", "\n## ", "\n### ", "\n#### ", "\n##### ", "\n###### ",
            "\n```", "\n---\n",
            *common,
        ]
    elif source_type == "pdf":
        return ["\n\n", "\n• ", "\n- ", "\n", *common[2:]]
    else:
        return common


def _get_chunk_config(text_length: int, source_type: str) -> dict | None:
    """根据文档长度和类型返回 (chunk_size, chunk_overlap)。"""
    if text_length <= SHORT_DOC_THRESHOLD:
        return None  # 不分块

    if source_type == "markdown":
        if text_length >= HUGE_DOC_THRESHOLD:
            return {"chunk_size": 1300, "chunk_overlap": 180}
        if text_length >= LARGE_DOC_THRESHOLD:
            return {"chunk_size": 1100, "chunk_overlap": 160}
        return {"chunk_size": 900, "chunk_overlap": 120}

    if source_type == "pdf":
        if text_length >= HUGE_DOC_THRESHOLD:
            return {"chunk_size": 1200, "chunk_overlap": 180}
        if text_length >= LARGE_DOC_THRESHOLD:
            return {"chunk_size": 1000, "chunk_overlap": 140}
        return {"chunk_size": 850, "chunk_overlap": 120}

    # text
    if text_length >= HUGE_DOC_THRESHOLD:
        return {"chunk_size": 1200, "chunk_overlap": 160}
    if text_length >= LARGE_DOC_THRESHOLD:
        return {"chunk_size": 950, "chunk_overlap": 120}
    return {"chunk_size": DEFAULT_CHUNK_SIZE, "chunk_overlap": DEFAULT_CHUNK_OVERLAP}


def _normalize_chunk(text: str) -> str:
    """清理多余空行。"""
    import re
    return re.sub(r"\n{3,}", "\n\n", text).strip()


async def _split_single_document(doc: Document) -> List[Document]:
    """分割单个文档。"""
    base_metadata = dict(doc.metadata)
    source_type = _get_source_type(base_metadata.get("source"))
    normalized_content = _normalize_chunk(doc.page_content)

    if not normalized_content:
        return []

    chunk_config = _get_chunk_config(len(normalized_content), source_type)

    if not chunk_config:
        # 短文档不分块
        return [
            Document(
                page_content=normalized_content,
                metadata={
                    **base_metadata,
                    "source": base_metadata.get("source", "unknown_source"),
                    "_sourceType": source_type,
                    "_splitStrategy": "keep_whole",
                },
            )
        ]

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_config["chunk_size"],
        chunk_overlap=chunk_config["chunk_overlap"],
        separators=_get_separators(source_type),
        length_function=len,
    )

    chunks = splitter.split_text(normalized_content)

    return [
        Document(
            page_content=_normalize_chunk(chunk),
            metadata={
                **base_metadata,
                "source": base_metadata.get("source", "unknown_source"),
                "_sourceType": source_type,
                "_splitStrategy": "adaptive_recursive",
                "_chunkSize": chunk_config["chunk_size"],
                "_chunkOverlap": chunk_config["chunk_overlap"],
            },
        )
        for chunk in chunks
        if _normalize_chunk(chunk)
    ]


async def split_documents(docs: List[Document]) -> List[Document]:
    """分割文档列表。"""
    if not docs:
        return []

    groups = []
    for doc in docs:
        chunks = await _split_single_document(doc)
        groups.append(chunks)

    result = []
    chunk_index = 0
    for group in groups:
        for chunk in group:
            result.append(
                Document(
                    page_content=chunk.page_content,
                    metadata={
                        **chunk.metadata,
                        "_chunkIndex": chunk_index,
                    },
                )
            )
            chunk_index += 1

    return result
```

- [ ] **步骤 2：Commit**

```bash
git add backend-py/src/kb/02_splitter.py
git commit -m "feat(backend-py): add text splitter (kb/02_splitter.py)"
```

---

### 任务 7：创建 `kb/04_ingest.py` — 文档摄入

**文件：**
- 创建：`backend-py/src/kb/04_ingest.py`

- [ ] **步骤 1：创建 `src/kb/04_ingest.py`**

对齐 TS `04_ingest.ts`。使用 `utils.llm.embeddings` 生成向量，`collection.insert_many` 批量写入。

```python
"""知识库摄入流水线 —— embed + insert。"""

import hashlib
import logging
from typing import List
from langchain_core.documents import Document
from src.utils.llm import embeddings
from src.kb[03_vector_store](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/03_vector_store.py) import get_kb_collection

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
```

- [ ] **步骤 2：Commit**

```bash
git add backend-py/src/kb/04_ingest.py
git commit -m "feat(backend-py): add document ingestion (kb/04_ingest.py)"
```

---

### 任务 8：创建 `kb/05_retriever.py` — 检索器

**文件：**
- 创建：`backend-py/src/kb/05_retriever.py`

- [ ] **步骤 1：创建 `src/kb/05_retriever.py`**

完整移植 TS `05_retriever.ts`。双后端检索 + Atlas 失败自动降级（5 分钟 TTL）。

```python
"""检索器 —— Atlas 向量搜索 + 应用层余弦相似度降级。"""

import logging
import math
import time
from typing import List, Tuple
from pymongo.errors import ServerSelectionTimeoutError
from langchain_core.documents import Document
from src.config import settings
from src.utils.llm import embeddings
from src.kb[03_vector_store](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/03_vector_store.py) import get_kb_collection

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

    stored = collection.find(
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
            # 非配置错误，可能是连接问题，重新抛出或降级
            logger.warning(f"[retriever] Atlas vector search error, falling back: {e}")
            _disable_atlas_temporarily()
            return await _retrieve_with_app_cosine(query_embedding, k)

        _disable_atlas_temporarily()
        logger.warning(
            f"[retriever] Atlas Vector Search is unavailable; falling back to app_cosine for "
            f"{VECTOR_SEARCH_FALLBACK_TTL_MS / 1000}s. {e}"
        )
        return await _retrieve_with_app_cosine(query_embedding, k)
```

- [ ] **步骤 2：Commit**

```bash
git add backend-py/src/kb/05_retriever.py
git commit -m "feat(backend-py): add retriever (kb/05_retriever.py)"
```

---

### 任务 9：迁移 `agent/01_policy.py` 和 `agent/03_memory.py`

**文件：**
- 创建/覆盖：`backend-py/src/agent/01_policy.py`（从 `agent/policy.py` 迁移）
- 创建/覆盖：`backend-py/src/agent/03_memory.py`（从 `agent/memory.py` 迁移，适配新 config）
- 修改：`backend-py/src/agent/__init__.py`

- [ ] **步骤 1：迁移 `01_policy.py`**

内容不变，直接从 `agent/policy.py` 复制到 `agent/01_policy.py`。

```bash
cp backend-py/src/agent/policy.py backend-py/src/agent/01_policy.py
```

- [ ] **步骤 2：迁移 `03_memory.py`**

从 `agent/memory.py` 复制到 `agent/03_memory.py`。修改 MongoDB 客户端连接方式：使用 `src.utils.mongo.get_mongo_client()` 替代内联 MongoClient 创建。数据库名从 `config.MONGODB_DB_NAME` 已经是 `"agentic-rag"`（任务 1 已改）。

```python
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
```

- [ ] **步骤 3：更新 `__init__.py`**

```python
# agent 模块
```

- [ ] **步骤 4：Commit**

```bash
git add backend-py/src/agent/01_policy.py backend-py/src/agent/03_memory.py backend-py/src/agent/__init__.py
git commit -m "refactor(backend-py): migrate policy and memory to numbered files"
```

---

### 任务 10：重写 `agent/02_agent.py` — Agent 状态机

**文件：**
- 创建：`backend-py/src/agent/02_agent.py`（重写，对齐 TS 完整实现）
- 注意：保留旧 `agent.py` 待到最终清理

- [ ] **步骤 1：创建 `src/agent/02_agent.py`**

完整重写，对齐 TS `02_agent.ts` 的 10 节点状态机。关键变更：
- 导入 `src.utils.llm` 模块级单例，不再每次 `_get_chat_model()`
- 使用 `src.kb[05_retriever](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/05_retriever.py).retrieve_relevant_chunks` 替代旧的 `embed_query` + `search_similar`
- 新增 `rerank_docs_with_llm` 函数（LLM-based rerank，对齐 TS）
- 状态字段对齐 TS 14 个字段
- `buildQueryPlan` 使用 `reflection_model`（对齐 TS）
- `rerankDocsWithLLM` 使用 `rerank_model`（对齐 TS）
- `generateAnswer` 使用 `chat_model`（对齐 TS）
- `reflectAnswer` 使用 `rerank_model`（对齐 TS）
- Zod schema 用 pydantic 替代

```python
"""LangGraph Agent 状态机 —— plan→retrieve→rerank→answer→reflect（对齐 TS 10 节点）。"""

import json
import logging
from typing import Any, Dict, List, Optional, Literal, Callable, Awaitable

from langchain_core.documents import Document
from langgraph.graph import StateGraph, START, END
from langgraph.graph.state import CompiledStateGraph
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

from src.config import settings
from src.agent[01_policy](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/01_policy.py) import AGENT_SYSTEM_PROMPT
from src.kb[05_retriever](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/05_retriever.py) import retrieve_relevant_chunks
from src.utils.llm import chat_model, rerank_model, reflection_model, embeddings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------
# 常量
# ---------------------------------------------------------------
FALLBACK_ANSWER = "根据现有的知识库文档，我暂时无法可靠回答这个问题。"
WEB_SEARCH_CANCELLED = "已取消联网搜索。"
WEB_SEARCH_EMPTY = "已尝试联网搜索，但没有检索到足够可靠的公开网页结果。"
WEB_SEARCH_NO_API_KEY = "已确认联网搜索，但服务端尚未配置 TAVILY_API_KEY，暂时无法执行互联网检索。"

# ---------------------------------------------------------------
# 类型
# ---------------------------------------------------------------
WebSearchDecision = Literal["confirm", "cancel"]
RetrievalFallbackReason = Literal["no_retrieval", "low_confidence"]
AnswerSource = Literal["kb", "web", "none"]
ReflectionAction = Literal["accept", "rewrite", "ask_web_search"]
AgentStage = Literal[
    "planning", "retrieving", "reranking", "answering",
    "web_searching", "reflecting",
]

DEFAULT_QUERY_PLAN = {
    "intent": "answer_question",
    "needsKbRetrieval": True,
    "needsWebSearch": False,
    "searchQuery": "",
    "answerStyle": "concise",
    "riskLevel": "low",
}

# 全局 checkpointer
_checkpointer: Optional[MemorySaver] = None


def _get_checkpointer() -> MemorySaver:
    global _checkpointer
    if _checkpointer is None:
        _checkpointer = MemorySaver()
    return _checkpointer


# ---------------------------------------------------------------
# 回调类型
# ---------------------------------------------------------------
OnStageCallback = Callable[[AgentStage], Awaitable[None]]
OnTokenCallback = Callable[[str], Awaitable[None]]


# ---------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------
def _get_latest_user_message(messages: List[dict]) -> Optional[dict]:
    for m in reversed(messages):
        if m.get("role") == "user" and m.get("content", "").strip():
            return m
    return None


def _format_history(messages: List[dict]) -> str:
    lines = []
    for m in messages:
        role = "助手" if m.get("role") == "assistant" else "用户"
        lines.append(f"{role}: {m.get('content', '')}")
    return "\n".join(lines)


def _format_kb_context(docs: List[Document]) -> str:
    parts = []
    for i, doc in enumerate(docs):
        source = doc.metadata.get("source", "unknown")
        parts.append(f"资料{i + 1}（{source}）\n{doc.page_content}")
    return "\n\n".join(parts)


def _format_web_context(results: List[dict]) -> str:
    parts = []
    for i, r in enumerate(results):
        parts.append(
            f"网页{i + 1}\n"
            f"标题：{r.get('title', '未命名')}\n"
            f"链接：{r.get('url', '')}\n"
            f"相关度：{r.get('score', 0)}\n"
            f"{r.get('content', '')}"
        )
    return "\n\n".join(parts)


def _build_kb_citations(docs: List[Document]) -> List[dict]:
    seen = set()
    citations = []
    for doc in docs:
        source = doc.metadata.get("source", "unknown_source")
        if source in seen:
            continue
        seen.add(source)
        preview = doc.page_content[:400] + ("..." if len(doc.page_content) > 400 else "")
        citations.append({"source": source, "preview": preview, "type": "kb"})
    return citations


def _truncate_for_rerank(text: str, max_chars: int = 900) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "..."


def _extract_text(content) -> str:
    """提取 LLM 响应的文本内容。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    return str(content)


# ---------------------------------------------------------------
# LLM-based Rerank（对齐 TS rerankDocsWithLLM）
# ---------------------------------------------------------------
async def _rerank_docs_with_llm(
    query: str,
    docs: List[Document],
    top_k: int,
) -> List[Document]:
    """用 rerank_model 对候选文档排序。"""
    if len(docs) <= 1:
        return docs[:top_k]

    candidates = [
        {"id": i, "text": _truncate_for_rerank(doc.page_content, 900)}
        for i, doc in enumerate(docs)
    ]

    prompt = [
        {
            "role": "system",
            "content": "你是一个 rerank 模型。给定用户问题与候选段落，选择最有助于回答该问题的段落，并按相关性从高到低排序。必须返回 JSON 格式，包含一个 `order` 字段，其值为候选段落的 id 数组。",
        },
        {
            "role": "user",
            "content": json.dumps(
                {"query": query, "topK": top_k, "candidates": candidates},
                ensure_ascii=False,
            ),
        },
    ]

    try:
        resp = await rerank_model.ainvoke(prompt)
        text = _extract_text(resp.content)
        parsed = json.loads(text)
        order = parsed.get("order", [])
    except Exception as e:
        logger.warning(f"Rerank failed: {e}")
        return docs[:top_k]

    seen = set()
    picked = []
    for idx in order:
        if len(picked) >= top_k:
            break
        if not isinstance(idx, int) or idx < 0 or idx >= len(docs):
            continue
        if idx in seen:
            continue
        seen.add(idx)
        picked.append(docs[idx])

    # 补全
    for i, doc in enumerate(docs):
        if len(picked) >= top_k:
            break
        if i not in seen:
            picked.append(doc)

    return picked


# ---------------------------------------------------------------
# Agent 构建
# ---------------------------------------------------------------
def _create_agent_graph(
    on_stage: Optional[OnStageCallback] = None,
    on_token: Optional[OnTokenCallback] = None,
    signal: Optional[Any] = None,
) -> CompiledStateGraph:
    """构建 10 节点 LangGraph 状态机。"""

    async def _assert_not_aborted():
        if signal and hasattr(signal, "aborted") and signal.aborted:
            raise Exception("AbortError")

    async def _plan_query(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("planning")

        messages = state.get("messages", [])
        latest = _get_latest_user_message(messages)

        if not latest:
            return {"queryPlan": DEFAULT_QUERY_PLAN}

        prompt = [
            {
                "role": "system",
                "content": "你是 RAG 问答系统的计划器。根据对话历史生成执行计划，只返回 JSON。",
            },
            {
                "role": "user",
                "content": json.dumps({
                    "task": "判断这个问题应该如何检索和回答。searchQuery 必须是适合向量检索的完整独立问题。",
                    "conversation": messages,
                }, ensure_ascii=False),
            },
        ]

        try:
            resp = await reflection_model.ainvoke(prompt)
            text = _extract_text(resp.content)
            plan = json.loads(text)
            return {
                "queryPlan": {
                    "intent": plan.get("intent", DEFAULT_QUERY_PLAN["intent"]),
                    "needsKbRetrieval": plan.get("needsKbRetrieval", True),
                    "needsWebSearch": plan.get("needsWebSearch", False),
                    "searchQuery": plan.get("searchQuery", latest.get("content", "")),
                    "answerStyle": plan.get("answerStyle", "concise"),
                    "riskLevel": plan.get("riskLevel", "low"),
                }
            }
        except Exception as e:
            logger.warning(f"plan_query 失败: {e}")
            return {
                "queryPlan": {
                    **DEFAULT_QUERY_PLAN,
                    "searchQuery": latest.get("content", ""),
                }
            }

    async def _retrieve(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("retrieving")

        messages = state.get("messages", [])
        plan = state.get("queryPlan", DEFAULT_QUERY_PLAN)
        latest = _get_latest_user_message(messages)
        question = latest.get("content", "").strip() if latest else ""
        search_query = plan.get("searchQuery", question) or question

        if not plan.get("needsKbRetrieval", True):
            return {
                "docs": [], "citations": [], "confidence": 0,
                "fallbackReason": "no_retrieval", "question": question,
                "shouldAskWebSearch": plan.get("needsWebSearch", False),
                "answerSource": "none",
                "webResults": [], "webSearchDecision": None,
                "webSearchError": None, "reflectionAction": "accept",
            }

        candidate_k = (
            max(settings.RERANK_CANDIDATES, settings.RERANK_TOP_K)
            if settings.RERANK_ENABLED
            else settings.RERANK_TOP_K
        )

        result = await retrieve_relevant_chunks(search_query, candidate_k)
        docs = result["docs"]
        confidence = result["confidence"]

        fallback_reason = None
        if not docs:
            fallback_reason = "no_retrieval"
        elif confidence < settings.RETRIEVAL_LOW_CONFIDENCE_THRESHOLD:
            fallback_reason = "low_confidence"

        # LLM-based Rerank
        final_docs = docs
        if not fallback_reason and settings.RERANK_ENABLED and len(docs) > 1:
            if on_stage:
                await on_stage("reranking")
            try:
                final_docs = await _rerank_docs_with_llm(
                    query=search_query,
                    docs=docs,
                    top_k=settings.RERANK_TOP_K,
                )
            except Exception as e:
                logger.warning(f"重排序失败: {e}")
                final_docs = docs[: settings.RERANK_TOP_K]

        if not fallback_reason:
            final_docs = final_docs[: settings.RERANK_TOP_K]

        citations = _build_kb_citations(final_docs) if not fallback_reason else []

        return {
            "docs": final_docs, "citations": citations,
            "confidence": confidence, "fallbackReason": fallback_reason,
            "question": question,
            "shouldAskWebSearch": plan.get("needsWebSearch", False) or bool(fallback_reason),
            "answerSource": "none",
            "webResults": [], "webSearchDecision": None,
            "webSearchError": None, "reflectionAction": "accept",
        }

    def _ask_web_search(state: dict) -> dict:
        plan = state.get("queryPlan", DEFAULT_QUERY_PLAN)
        fallback = state.get("fallbackReason")

        if plan.get("needsWebSearch"):
            reason_msg = "这个问题可能需要知识库之外的最新或公开信息。"
        elif fallback == "no_retrieval":
            reason_msg = "知识库中没有检索到可用于回答当前问题的内容。"
        else:
            reason_msg = "知识库检索到了内容，但当前结果置信度偏低。"

        question = state.get("question", "")

        decision = interrupt({
            "type": "web_search_confirmation",
            "message": f"{reason_msg} 是否需要改为联网搜索后再生成答案？",
            "question": question,
            "reason": fallback or "low_confidence",
            "confidence": state.get("confidence"),
            "confirmLabel": "确定",
            "cancelLabel": "取消",
        })

        return {
            "webSearchDecision": decision["action"] if isinstance(decision, dict) else decision,
        }

    async def _answer_from_kb(state: dict) -> dict:
        question = state.get("question", "")
        docs = state.get("docs", [])

        if not question or not docs:
            return {"answer": FALLBACK_ANSWER, "answerSource": "none", "citations": []}

        await _assert_not_aborted()
        if on_stage:
            await on_stage("answering")

        plan = state.get("queryPlan", DEFAULT_QUERY_PLAN)
        messages = state.get("messages", [])

        prompt = [
            {"role": "system", "content": AGENT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "\n".join([
                    "以下是对话历史：",
                    _format_history(messages),
                    "",
                    "以下是可用知识库文档上下文：",
                    _format_kb_context(docs),
                    "",
                    f"请只基于这些知识库文档回答最后一个用户问题。回答风格：{plan.get('answerStyle', 'concise')}。风险等级：{plan.get('riskLevel', 'low')}；风险越高，越要保守。",
                ]),
            },
        ]

        answer = ""
        async for chunk in chat_model.astream(prompt):
            await _assert_not_aborted()
            token = _extract_text(chunk.content) if chunk.content else ""
            if token:
                answer += token
                if on_token:
                    await on_token(token)

        answer = answer.strip() or FALLBACK_ANSWER
        return {"answer": answer, "answerSource": "kb", "citations": state.get("citations", [])}

    async def _search_web(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("web_searching")

        question = state.get("question", "")

        if not settings.TAVILY_API_KEY:
            return {"citations": [], "webResults": [], "webSearchError": WEB_SEARCH_NO_API_KEY}

        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=settings.TAVILY_API_KEY)
            response = client.search(query=question, search_depth="advanced", max_results=5)
            await _assert_not_aborted()

            results = response.get("results", [])
            web_results = [
                {
                    "title": r.get("title", ""),
                    "url": r.get("url", ""),
                    "content": r.get("content", ""),
                    "score": r.get("score", 0),
                }
                for r in results
            ]

            citations = [
                {
                    "source": r["title"] or r["url"],
                    "preview": r["content"][:400] + ("..." if len(r.get("content", "")) > 400 else ""),
                    "url": r["url"],
                    "type": "web",
                }
                for r in web_results
            ]

            return {"citations": citations, "webResults": web_results, "webSearchError": None}
        except Exception as e:
            logger.error(f"联网搜索失败: {e}")
            return {"citations": [], "webResults": [], "webSearchError": "联网搜索失败，请稍后重试。"}

    async def _answer_from_web(state: dict) -> dict:
        error = state.get("webSearchError")
        if error:
            return {"answer": error, "answerSource": "none", "citations": []}

        web_results = state.get("webResults", [])
        if not web_results:
            return {"answer": WEB_SEARCH_EMPTY, "answerSource": "none", "citations": []}

        await _assert_not_aborted()
        if on_stage:
            await on_stage("answering")

        messages = state.get("messages", [])

        prompt = [
            {"role": "system", "content": AGENT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "\n".join([
                    "以下是对话历史：",
                    _format_history(messages),
                    "",
                    "以下是联网搜索结果：",
                    _format_web_context(web_results),
                    "",
                    "请优先基于这些联网搜索结果回答最后一个用户问题；如果来源之间存在冲突，请明确说明。",
                ]),
            },
        ]

        answer = ""
        async for chunk in chat_model.astream(prompt):
            await _assert_not_aborted()
            token = _extract_text(chunk.content) if chunk.content else ""
            if token:
                answer += token
                if on_token:
                    await on_token(token)

        answer = answer.strip() or WEB_SEARCH_EMPTY
        return {"answer": answer, "answerSource": "web", "citations": state.get("citations", [])}

    async def _reflect_answer(state: dict) -> dict:
        await _assert_not_aborted()
        if on_stage:
            await on_stage("reflecting")

        answer = state.get("answer", "")
        answer_source = state.get("answerSource", "none")
        docs = state.get("docs", [])
        web_results = state.get("webResults", [])

        if not answer.strip() or answer in (
            FALLBACK_ANSWER, WEB_SEARCH_CANCELLED, WEB_SEARCH_EMPTY, WEB_SEARCH_NO_API_KEY,
        ):
            return {"reflectionAction": "accept"}

        context = _format_web_context(web_results) if answer_source == "web" else _format_kb_context(docs)

        if not context.strip():
            new_answer = WEB_SEARCH_EMPTY if answer_source == "web" else FALLBACK_ANSWER
            return {"reflectionAction": "rewrite", "answer": new_answer}

        prompt = [
            {"role": "system", "content": "你是 RAG 答案审查器。检查答案是否严格由给定上下文支持，只返回 JSON。"},
            {
                "role": "user",
                "content": json.dumps({
                    "task": "判断 assistantAnswer 是否完全受到 suppliedContext 支持。若答案包含上下文外断言，返回 rewrite 并给出更保守的 answer。知识库答案明显需要外部信息时可返回 ask_web_search。",
                    "allowedActions": ["accept", "rewrite", "ask_web_search"] if answer_source == "kb" else ["accept", "rewrite"],
                    "answerSource": answer_source,
                    "suppliedContext": context,
                    "assistantAnswer": answer,
                }, ensure_ascii=False),
            },
        ]

        try:
            resp = await rerank_model.ainvoke(prompt)
            text = _extract_text(resp.content)
            reflection = json.loads(text)
            action = reflection.get("action", "accept")

            if answer_source == "web" and action == "ask_web_search":
                action = "rewrite"

            if action == "rewrite":
                new_answer = reflection.get("answer") or (
                    WEB_SEARCH_EMPTY if answer_source == "web" else FALLBACK_ANSWER
                )
                return {"reflectionAction": "rewrite", "answer": new_answer}

            if action == "ask_web_search":
                return {
                    "reflectionAction": "ask_web_search",
                    "fallbackReason": "low_confidence",
                    "shouldAskWebSearch": True,
                }

            return {"reflectionAction": "accept"}
        except Exception as e:
            logger.warning(f"反思失败: {e}")
            return {"reflectionAction": "accept"}

    def _cancel_web_search(state: dict) -> dict:
        return {"answer": WEB_SEARCH_CANCELLED, "answerSource": "none", "citations": []}

    # 构建图
    builder = StateGraph(dict)

    builder.add_node("plan_query", _plan_query)
    builder.add_node("retrieve", _retrieve)
    builder.add_node("ask_web_search_confirmation", _ask_web_search)
    builder.add_node("answer_from_kb", _answer_from_kb)
    builder.add_node("search_web", _search_web)
    builder.add_node("answer_from_web", _answer_from_web)
    builder.add_node("reflect_answer", _reflect_answer)
    builder.add_node("cancel_web_search", _cancel_web_search)

    builder.add_edge(START, "plan_query")
    builder.add_edge("plan_query", "retrieve")

    def _route_after_retrieve(state: dict) -> str:
        return "ask_web_search_confirmation" if state.get("shouldAskWebSearch") else "answer_from_kb"

    builder.add_conditional_edges("retrieve", _route_after_retrieve, {
        "ask_web_search_confirmation": "ask_web_search_confirmation",
        "answer_from_kb": "answer_from_kb",
    })

    def _route_after_web_search_confirm(state: dict) -> str:
        return "search_web" if state.get("webSearchDecision") == "confirm" else "cancel_web_search"

    builder.add_conditional_edges("ask_web_search_confirmation", _route_after_web_search_confirm, {
        "search_web": "search_web",
        "cancel_web_search": "cancel_web_search",
    })

    builder.add_edge("answer_from_kb", "reflect_answer")

    def _route_after_reflect(state: dict) -> str:
        return "ask_web_search_confirmation" if state.get("reflectionAction") == "ask_web_search" else END

    builder.add_conditional_edges("reflect_answer", _route_after_reflect, {
        "ask_web_search_confirmation": "ask_web_search_confirmation",
        END: END,
    })

    builder.add_edge("search_web", "answer_from_web")
    builder.add_edge("answer_from_web", "reflect_answer")
    builder.add_edge("cancel_web_search", END)

    return builder.compile(checkpointer=_get_checkpointer())


# ---------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------
async def run_agent(
    messages: List[dict],
    thread_id: str,
    decision: Optional[str] = None,
    on_stage: Optional[OnStageCallback] = None,
    on_token: Optional[OnTokenCallback] = None,
    signal: Optional[Any] = None,
) -> dict:
    """运行 Agent 状态机。"""
    graph = _create_agent_graph(on_stage=on_stage, on_token=on_token, signal=signal)
    config = {"configurable": {"thread_id": thread_id}}

    if decision:
        result = await graph.ainvoke(Command(resume={"action": decision}), config)
    else:
        result = await graph.ainvoke({"messages": messages}, config)

    # 检查是否 interrupt
    try:
        if hasattr(graph, "is_interrupted") and graph.is_interrupted(result):
            import langgraph
            interrupt_data = result.get(langgraph.types.INTERRUPT, [])
            if interrupt_data and hasattr(interrupt_data[0], "value"):
                return {"type": "interrupt", "interrupt": interrupt_data[0].value}
            return {"type": "interrupt", "interrupt": {
                "type": "web_search_confirmation",
                "message": "是否需要联网搜索？",
            }}
    except Exception:
        pass

    return {
        "type": "done",
        "answer": result.get("answer", "").strip() or FALLBACK_ANSWER,
        "citations": result.get("citations", []),
    }
```

- [ ] **步骤 2：验证 Agent 可导入**

```bash
cd backend-py && python -c "
from src.agent[02_agent](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/02_agent.py) import run_agent
print('Agent import OK')
"
```

预期：`Agent import OK`（无模型下载）。

- [ ] **步骤 3：Commit**

```bash
git add backend-py/src/agent/02_agent.py
git commit -m "refactor(backend-py): rewrite agent with LLM-based rerank (agent/02_agent.py)"
```

---

### 任务 11：适配 `routes/agent.py` 和 `routes/kb.py`

**文件：**
- 修改：`backend-py/src/routes/agent.py`（更新导入路径）
- 修改：`backend-py/src/routes/kb.py`（更新导入路径，移除 ChromaDB 引用）

- [ ] **步骤 1：修改 `src/routes/agent.py`**

只改导入路径：
```python
# 旧
from src.agent.agent import run_agent
from src.agent.memory import append_to_history, ensure_thread_id, get_history
# 新
from src.agent[02_agent](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/02_agent.py) import run_agent
from src.agent[03_memory](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/03_memory.py) import append_to_history, ensure_thread_id, get_history
```

- [ ] **步骤 2：修改 `src/routes/kb.py`**

更新导入：
```python
# 旧
from src.rag.ingest import compute_sha256, ingest_file
from src.rag.loaders import load_file
from src.rag.splitter import splitter
from src.rag.vector_store import get_kb_collection, get_kb_files_collection
# 新
from src.kb[01_loaders](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/01_loaders.py) import load_file_as_documents
from src.kb[02_splitter](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/02_splitter.py) import split_documents
from src.kb[03_vector_store](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/03_vector_store.py) import get_kb_collection, get_kb_files_collection
from src.kb[04_ingest](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/04_ingest.py) import ingest_documents, compute_sha256
```

移除对 `settings.VECTOR_STORE` 的引用（如 `if settings.VECTOR_STORE == "mongodb"` → 直接用 MongoDB）。

上传流程改为：
```python
raw_docs = await load_file_as_documents(uploaded_path, content_type, decoded_name)
chunks = await split_documents(raw_docs)
summary = await ingest_documents(chunks)
```

- [ ] **步骤 3：Commit**

```bash
git add backend-py/src/routes/agent.py backend-py/src/routes/kb.py
git commit -m "refactor(backend-py): adapt routes to new kb/agent module paths"
```

---

### 任务 12：清理旧文件和依赖

**文件：**
- 删除：`backend-py/src/rag/` 整个目录
- 删除：`backend-py/src/agent/agent.py`
- 删除：`backend-py/src/agent/policy.py`
- 删除：`backend-py/src/agent/memory.py`
- 修改：`backend-py/pyproject.toml`

- [ ] **步骤 1：删除 `rag/` 目录**

```bash
rm -rf backend-py/src/rag/
```

- [ ] **步骤 2：删除旧 agent 文件**

```bash
rm backend-py/src/agent/agent.py backend-py/src/agent/policy.py backend-py/src/agent/memory.py
```

- [ ] **步骤 3：清理 `pyproject.toml` 依赖**

移除以下依赖：
- `sentence-transformers>=3.3.0`
- `jieba>=0.42.1`
- `chromadb>=0.5.0`
- `chardet>=5.2.0`
- `FlagEmbedding>=1.3.0`

保留依赖：
```toml
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "langchain>=0.3.0",
    "langchain-openai>=0.2.0",
    "langgraph>=0.2.0",
    "pymupdf>=1.24.0",
    "pymongo>=4.10.0",
    "pydantic>=2.10.0",
    "pydantic-settings>=2.6.0",
    "python-multipart>=0.0.12",
    "openai>=1.55.0",
    "aiofiles>=24.1.0",
    "tavily-python>=0.5.0",
    "langchain-text-splitters>=1.1.2",
    "langchain-mongodb>=0.2.0",
]
```

注意：新增 `langchain-mongodb>=0.2.0`（`MongoDBAtlasVectorSearch` 需要）。

- [ ] **步骤 4：同步 lock 文件**

```bash
cd backend-py && uv sync
```

- [ ] **步骤 5：最终验证导入**

```bash
cd backend-py && python -c "
from src.config import settings
from src.utils.llm import chat_model, embeddings
from src.kb[05_retriever](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/05_retriever.py) import retrieve_relevant_chunks
from src.agent[02_agent](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/02_agent.py) import run_agent
from src.routes import agent, kb
print('All imports OK')
"
```

- [ ] **步骤 6：Commit**

```bash
git add backend-py/pyproject.toml backend-py/uv.lock
git rm -r backend-py/src/rag/
git rm backend-py/src/agent/agent.py backend-py/src/agent/policy.py backend-py/src/agent/memory.py
git commit -m "refactor(backend-py): remove old rag/ files and clean dependencies"
```

---

## 最终验证

- [ ] **运行完整导入检查**

```bash
cd backend-py && python -c "
from src.config import settings
from src.utils.llm import chat_model, rerank_model, reflection_model, embeddings
from src.utils.mongo import get_mongo_client, get_db
from src.kb.local_store import get_local_kb_collection
from src.kb[03_vector_store](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/03_vector_store.py) import get_kb_collection, get_kb_files_collection
from src.kb[05_retriever](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/05_retriever.py) import retrieve_relevant_chunks
from src.agent[01_policy](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/01_policy.py) import AGENT_SYSTEM_PROMPT
from src.agent[02_agent](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/02_agent.py) import run_agent
from src.agent[03_memory](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/agent/03_memory.py) import ensure_thread_id, get_history, append_to_history
from src.kb[01_loaders](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/01_loaders.py) import load_file_as_documents
from src.kb[02_splitter](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/02_splitter.py) import split_documents
from src.kb[04_ingest](file:///Users/qiufeng/projects/agent-with-rag/backend-py/src/kb/04_ingest.py) import ingest_documents, compute_sha256
print('All imports OK')
"
```

预期：`All imports OK`，无报错、不下载本地模型。

- [ ] **最终 Commit**

```bash
git add -A
git commit -m "refactor(backend-py): complete RAG refactoring to align with TS backend"
```
