# backend-py — Python 版中文优化 RAG 后端

基于 FastAPI + LangGraph + BGE 中文模型的知识库问答后端。

## 快速开始

```bash
cd backend-py

# 安装依赖
pip install -e .

# 配置环境变量
cp ../backend/.env .env   # 复用 TS 后端的 .env 配置
# 编辑 .env 添加 BGE 相关配置（见下方）

# 启动开发服务器
uvicorn src.main:app --reload --host 0.0.0.0 --port 4000
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `4000` |
| `OPENAI_API_KEY` | OpenAI API 密钥（LLM 调用） | — |
| `OPENAI_BASE_URL` | OpenAI 兼容 API 地址 | `https://api.openai.com/v1` |
| `MONGODB_ATLAS_URI` | MongoDB Atlas 连接串 | — |
| `MONGODB_DB_NAME` | MongoDB 数据库名 | `agent_rag` |
| `TAVILY_API_KEY` | Tavily 联网搜索 API 密钥 | — |
| `EMBEDDING_BACKEND` | embedding 后端：`bge` / `openai` | `bge` |
| `BGE_MODEL_NAME` | BGE embedding 模型名 | `BAAI/bge-large-zh-v1.5` |
| `EMBEDDING_BATCH_SIZE` | 批量 embedding 大小 | `32` |
| `RERANK_ENABLED` | 是否启用重排序 | `false` |
| `RERANKER_MODEL_NAME` | 重排序模型名 | `BAAI/bge-reranker-v2-m3` |
| `RERANK_CANDIDATES` | 重排序候选数 | `20` |
| `RERANK_TOP_K` | 重排序返回数 | `4` |
| `RETRIEVAL_MIN_SCORE` | 检索最低相似度阈值 | `0.5` |
| `RETRIEVAL_LOW_CONFIDENCE_THRESHOLD` | 触发联网搜索的置信度阈值 | `0.6` |
| `RETRIEVAL_BACKEND` | 检索后端：`atlas_vector` / `app_cosine` | `atlas_vector` |
| `VECTOR_STORE` | 向量存储：`mongodb` / `chromadb` | `mongodb` |
| `KB_VECTOR_INDEX_NAME` | Atlas Vector Search 索引名 | `kb_vector_index` |
| `VECTOR_SEARCH_NUM_CANDIDATES` | 向量搜索候选数 | `100` |
| `CHROMA_PERSIST_DIR` | ChromaDB 持久化目录 | `data/chroma` |
| `CHINESE_SPLITTER_STRATEGY` | 分割策略：`jieba` / `recursive` | `jieba` |
| `JIEBA_USER_DICT` | jieba 自定义词典路径 | — |
| `LLM_MODEL` | LLM 模型名 | `gpt-4o-mini` |
| `LLM_TEMPERATURE` | LLM 温度 | `0.1` |

## BGE 模型下载

首次启动时，BGE 模型会自动从 HuggingFace 下载到本地缓存（`~/.cache/huggingface/`）。

- **bge-large-zh-v1.5**: ~1.3GB，用于生成中文文本向量（1024 维）
- **bge-reranker-v2-m3**: ~2.3GB，用于检索结果重排序

如需离线部署，提前下载：

```bash
pip install huggingface-hub
huggingface-cli download BAAI/bge-large-zh-v1.5
huggingface-cli download BAAI/bge-reranker-v2-m3
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/kb/health` | 知识库健康检查 |
| `GET` | `/kb/files` | 列出已摄入文件 |
| `GET` | `/kb/files/exists?name=...&hash=...` | 检查文件是否已存在 |
| `POST` | `/kb/upload` | 上传文件（multipart） |
| `DELETE` | `/kb/files/:id` | 按 ID 删除文件 |
| `DELETE` | `/kb/files?name=...&hash=...` | 按名称/Hash 删除文件 |
| `POST` | `/agent/chat` | SSE 流式对话 |

接口签名与 TypeScript 版后端完全兼容，前端无需修改。

## 项目结构

```
backend-py/
├── pyproject.toml
├── src/
│   ├── main.py               # FastAPI 入口
│   ├── config.py              # 环境变量配置
│   ├── agent/
│   │   ├── policy.py           # 中文 Agent 系统提示词
│   │   ├── agent.py            # LangGraph 状态机
│   │   └── memory.py           # 对话历史管理
│   ├── rag/
│   │   ├── splitter.py         # jieba 中文文本分割器
│   │   ├── embeddings.py       # BGE + OpenAI embedding
│   │   ├── reranker.py         # BGE 重排序模型
│   │   ├── loaders.py          # 文档加载器（PyMuPDF + chardet）
│   │   ├── vector_store.py     # MongoDB + ChromaDB 向量存储
│   │   └── ingest.py           # 知识库摄入流水线
│   ├── routes/
│   │   ├── agent.py            # Agent SSE 路由
│   │   └── kb.py               # 知识库 CRUD 路由
│   └── models/
│       └── schemas.py          # Pydantic 数据模型
├── uploads/                    # 临时上传目录
└── data/                       # ChromaDB 持久化目录
```

## 与 TypeScript 版的差异

| 特性 | TypeScript 版 | Python 版 |
|------|--------------|-----------|
| 框架 | Express | FastAPI |
| Agent | LangGraph TS | LangGraph Python |
| Embedding | text-embedding-3-small | BGE-large-zh-v1.5（可切 OpenAI） |
| 重排序 | LLM JSON 重排序 | BGE Cross-Encoder 模型 |
| 文本分割 | 英文分隔符 | jieba 中文分词 + 中文标点 |
| 编码处理 | UTF-8 | chardet 自动检测 GBK/UTF-8 |
| 向量存储 | MongoDB Atlas | MongoDB Atlas + ChromaDB |
| PDF 加载 | pdf-parse | PyMuPDF |
