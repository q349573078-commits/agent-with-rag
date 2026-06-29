# backend-py RAG 重构设计

## 概述

将 `backend-py` 的 RAG、Embedding、Rerank 模块完全对齐 `backend` (TypeScript) 的实现方式：
去除所有本地模型依赖，统一使用 OpenAI API，重构目录结构至与 TS 后端一一对应。

## 目标目录结构

```
backend-py/src/
├── config.py                    # 简化配置，对齐 env.ts
├── main.py                      # FastAPI 入口（不变）
├── utils/                       # 新建
│   ├── __init__.py
│   ├── mongo.py                 # MongoDB 连接管理
│   └── llm.py                   # 模型实例化（对齐 openai.ts）
├── kb/                          # 新建，替代 rag/
│   ├── __init__.py
│   ├── 01_loaders.py            # 文档加载器
│   ├── 02_splitter.py           # 文本分割器（去 jieba）
│   ├── 03_vector_store.py       # 向量存储（去 ChromaDB）
│   ├── 04_ingest.py             # 文档摄入
│   ├── 05_retriever.py          # 检索器（新建）
│   └── local_store.py           # 本地 JSON 存储（新建）
├── agent/                       # 重构
│   ├── __init__.py
│   ├── 01_policy.py             # 系统提示词
│   ├── 02_agent.py              # 10 节点状态机（重写）
│   └── 03_memory.py             # 对话记忆
├── routes/
│   ├── __init__.py
│   ├── agent.py                 # 适配新 Agent 接口
│   └── kb.py                    # 适配新 kb 模块
└── models/
    ├── __init__.py
    └── schemas.py               # 保持不变
```

## 删除的文件

```
src/rag/embeddings.py      # BGE 本地模型 → 不再需要
src/rag/reranker.py         # FlagEmbedding → 改为 LLM-based
src/rag/__init__.py         # 整个 rag/ 目录移除
src/rag/vector_store.py     # 重写到 kb/03_vector_store.py
src/rag/splitter.py         # 重写到 kb/02_splitter.py（去 jieba）
src/rag/loaders.py          # 重写到 kb/01_loaders.py
src/rag/ingest.py           # 重写到 kb/04_ingest.py
```

## 各模块详细设计

### 1. config.py

**移除的配置：**
- `EMBEDDING_BACKEND` / `BGE_MODEL_NAME` / `EMBEDDING_BATCH_SIZE`
- `RERANKER_MODEL_NAME`
- `VECTOR_STORE` / `CHROMA_PERSIST_DIR`
- `CHINESE_SPLITTER_STRATEGY`

**保留/新增的配置：**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `OPENAI_API_KEY` | `""` | OpenAI API 密钥 |
| `LLM_MODEL` | `"gpt-4o-mini"` | 对话模型 |
| `LLM_TEMPERATURE` | `0.2` | 温度参数 |
| `EMBEDDING_MODEL` | `"text-embedding-3-small"` | Embedding 模型 |
| `RETRIEVAL_BACKEND` | `"atlas_vector"` | 检索后端 |
| `RETRIEVAL_MIN_SCORE` | `0.5` | 最低相似度阈值 |
| `RETRIEVAL_LOW_CONFIDENCE_THRESHOLD` | `0.6` | 低置信度阈值 |
| `KB_VECTOR_INDEX_NAME` | `"kb_vector_index"` | Atlas 向量索引名 |
| `VECTOR_SEARCH_NUM_CANDIDATES` | `100` | 向量搜索候选数 |
| `RERANK_ENABLED` | `false` | 是否启用 LLM Rerank |
| `RERANK_CANDIDATES` | `20` | Rerank 候选数 |
| `RERANK_TOP_K` | `4` | Rerank 后保留数 |
| `MONGODB_ATLAS_URI` | `""` | MongoDB 连接字符串 |
| `MONGODB_DB_NAME` | `"agentic-rag"` | 数据库名 |
| `TAVILY_API_KEY` | `""` | Tavily 搜索 API 密钥 |

### 2. utils/llm.py

模块级单例，对齐 TS `openai.ts`：

- `chat_model` — `ChatOpenAI(model="gpt-4o-mini", temperature=0.2)` — 答案生成
- `rerank_model` — `ChatOpenAI(model="gpt-4o-mini", temperature=0)` — Rerank + 反思
- `reflection_model` — `ChatOpenAI(model="gpt-4o-mini", temperature=0)` — 查询规划
- `embeddings` — `OpenAIEmbeddings(model="text-embedding-3-small")` — 向量嵌入

### 3. utils/mongo.py

从现有 `rag/vector_store.py` 提取 MongoDB 连接管理：

- `get_mongo_client()` — 懒加载单例 `MongoClient`
- `get_db()` — 返回 `client[db_name]`

### 4. kb/ 管道

#### 4.1 01_loaders.py

- `load_file(file_path, mime_type)` → `list[Document]`
- PDF：PyMuPDF 按页加载
- TXT/Markdown：UTF-8 直接读取
- 去掉 chardet 编码检测

#### 4.2 02_splitter.py

纯 `RecursiveCharacterTextSplitter`，自适应策略：

| 文档长度 | Markdown | PDF | 纯文本 |
|---------|----------|-----|--------|
| ≤500 字符 | 不分块 | 不分块 | 不分块 |
| 500~4000 | 900/120 | 850/120 | 800/120 |
| 4000~12000 | 1100/160 | 1000/140 | 950/120 |
| ≥12000 | 1300/180 | 1200/180 | 1200/160 |

分隔符按文档类型区分（Markdown: `#/##/###/代码块/---`，PDF: `\n\n/缩进/列表/中文标点/空格`）。

去掉 jieba 依赖。

#### 4.3 03_vector_store.py

- `get_mongo_collection_or_local()` — MongoDB 连接失败时降级到 `LocalKbCollection`
- `get_kb_collection()` — `kb_chunks` 集合懒加载单例
- `get_kb_files_collection()` — `kb_files` 集合懒加载单例，自动建索引
- `get_vector_store()` — `MongoDBAtlasVectorSearch` 实例
- 去掉 ChromaDB 降级

#### 4.4 local_store.py

实现 MongoDB Collection API 子集：

- `LocalKbCollection`：`find()`, `find_one()`, `insert_one()`, `insert_many()`, `update_one()`, `delete_one()`, `delete_many()`, `count_documents()`, `distinct()`, `aggregate()`（支持 `$vectorSearch`）, `create_index()`
- `LocalCursor`：`sort()`, `limit()`, `to_list()`
- 数据持久化到 `data/kb-local-store.json`

#### 4.5 04_ingest.py

- `ingest_documents(chunks)` → `{"ok", "totalChunks", "sources"}`
- 使用 `utils.llm.embeddings` 生成向量
- `collection.insert_many()` 批量写入

#### 4.6 05_retriever.py

- `retrieve_with_atlas_vector_search(query_emb, k)` — MongoDB Atlas 向量搜索
- `retrieve_with_app_cosine(query_emb, k)` — 应用层余弦相似度降级
- `retrieve_relevant_chunks(query, k)` — 主入口，Atlas 失败自动降级（5min TTL）

### 5. agent/02_agent.py

10 节点 LangGraph 状态机：

```
plan_query → retrieve → [shouldAskWebSearch?]
                           ├── NO  → answer_from_kb
                           └── YES → ask_web_search_confirmation (interrupt)
                                       ├── confirm → search_web → answer_from_web
                                       └── cancel  → answer_from_kb
                                       → reflect_answer → accept/rewrite/ask_web_search
```

**State 字段（14 个）：**
`question`, `messages`, `query_plan`, `docs`, `confidence`, `answer`, `answer_source`, `citations`, `fallback_reason`, `reflection_action`, `should_ask_web_search`, `web_results`, `web_search_decision`, `web_search_error`

**LLM-based Rerank：**
- `rerank_docs_with_llm(query, docs, top_k)` — 用 `rerank_model` 排序
- 每篇文档截断 900 字符
- Zod 校验输出格式 `{"ranked": [{"index": 0, "relevance": 0.95}, ...]}`
- 过滤低于 `RETRIEVAL_MIN_SCORE` 的结果

### 6. routes/agent.py

SSE 事件类型：
- `thread` — threadId
- `status` — 阶段切换（plan_query, retrieve, rerank, answer, reflect, ask_web_search）
- `chunk` — token 流
- `action_required` — 中断
- `done` — 完成
- `error` — 错误

中断恢复：`webSearchDecision: "confirm" | "cancel"` + `Command(resume=...)`

### 7. routes/kb.py

适配新 kb 模块接口。

## 依赖变更

**移除：**
- `sentence-transformers>=3.3.0`
- `FlagEmbedding>=1.3.0`
- `jieba>=0.42.1`
- `chromadb>=0.5.0`
- `chardet>=5.2.0`

**保留：**
- `langchain`, `langchain-openai`, `langgraph`, `langchain-text-splitters`
- `pymongo`, `pymupdf`, `tavily-python`
- `fastapi`, `uvicorn`, `pydantic-settings`

## 实现顺序

1. `config.py` — 精简配置
2. `utils/llm.py` + `utils/mongo.py` — 新建模型层
3. `kb/` — 管道重构
   - `local_store.py`
   - `03_vector_store.py`
   - `01_loaders.py`
   - `02_splitter.py`
   - `04_ingest.py`
   - `05_retriever.py`
4. `agent/01_policy.py` + `agent/03_memory.py` — 迁移
5. `agent/02_agent.py` — 重写状态机
6. `routes/agent.py` + `routes/kb.py` — 适配路由
7. 删除 `rag/` 目录
8. `pyproject.toml` — 清理依赖
