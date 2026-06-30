# backend-py — Python 版 RAG 问答后端

基于 FastAPI + LangGraph + OpenAI 的知识库问答后端，支持 PDF/TXT/Markdown 文档上传与向量检索。

## 快速开始

```bash
cd backend-py

# 创建虚拟环境并安装依赖
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

# 配置环境变量（见下方）
cp .env.example .env   # 编辑 .env 填入 OPENAI_API_KEY

# 启动开发服务器（端口冲突时自动重试 +1，最多 20 次）
python -m src.main
```

## 环境变量

配置文件读取 `.env`（pydantic-settings）。

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3001` |
| `OPENAI_API_KEY` | OpenAI API 密钥（必填） | — |
| `TAVILY_API_KEY` | Tavily 联网搜索 API 密钥（可选） | — |
| `MONGODB_ATLAS_URI` | MongoDB Atlas 连接串（可选，无则降级本地存储） | — |
| `MONGODB_DB_NAME` | MongoDB 数据库名 | `agentic-rag` |
| `LLM_MODEL` | 对话/重排序/反思模型 | `gpt-4o-mini` |
| `LLM_TEMPERATURE` | 答案生成温度 | `0.2` |
| `EMBEDDING_MODEL` | Embedding 模型 | `text-embedding-3-small` |
| `RERANK_ENABLED` | 是否启用 LLM 重排序 | `false` |
| `RERANK_CANDIDATES` | 重排序候选数 | `20` |
| `RERANK_TOP_K` | 重排序后保留数 | `4` |
| `RETRIEVAL_BACKEND` | 检索后端：`atlas_vector` / `app_cosine` | `atlas_vector` |
| `RETRIEVAL_MIN_SCORE` | 检索最低相似度阈值 | `0.5` |
| `RETRIEVAL_LOW_CONFIDENCE_THRESHOLD` | 低置信度触发反思阈值 | `0.6` |
| `KB_VECTOR_INDEX_NAME` | Atlas Vector Search 索引名 | `kb_vector_index` |
| `VECTOR_SEARCH_NUM_CANDIDATES` | 向量搜索候选数 | `100` |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 服务健康检查 |
| `GET` | `/kb/health` | 知识库健康检查（含存储后端信息） |
| `GET` | `/kb/files` | 列出已上传文件 |
| `GET` | `/kb/files/exists?name=...&hash=...` | 检查文件是否已存在 |
| `POST` | `/kb/upload` | 上传文件（multipart，支持 .pdf/.txt/.md/.markdown，最大 20MB） |
| `DELETE` | `/kb/files/:id` | 按 ID 删除文件及关联 chunks |
| `DELETE` | `/kb/files?name=...&hash=...` | 按名称/SHA256 删除文件 |
| `POST` | `/agent/chat` | SSE 流式对话 |

### Agent 对话请求体

```json
{
  "message": "什么是防抖",
  "threadId": "可选，用于多轮对话"
}
```

支持联网搜索中断/恢复：当检索置信度过低时，Agent 会通过 `action_required` 事件询问是否联网搜索，客户端携带 `webSearchDecision: "confirm" | "cancel"` 恢复对话。

## 项目结构

```
backend-py/
├── pyproject.toml
├── src/
│   ├── main.py                # FastAPI 入口，端口冲突自动重试
│   ├── config.py              # pydantic-settings 配置管理
│   ├── agent/
│   │   ├── 01_policy.py       # 中文 Agent 系统提示词
│   │   ├── 02_agent.py        # LangGraph 10 节点状态机
│   │   └── 03_memory.py       # 对话历史管理（MongoDB + 内存降级）
│   ├── kb/
│   │   ├── 01_loaders.py      # 文档加载器（PyMuPDF PDF / UTF-8 TXT/MD）
│   │   ├── 02_splitter.py     # 中文自适应文本分割器
│   │   ├── 03_vector_store.py # 向量存储抽象层（MongoDB Atlas / 本地 JSON 降级）
│   │   ├── 04_ingest.py       # 嵌入 + 批量写入向量存储
│   │   ├── 05_retriever.py    # 检索器（Atlas 向量搜索 / 余弦相似度降级）
│   │   └── local_store.py     # 本地 JSON 存储（模拟 MongoDB API）
│   ├── routes/
│   │   ├── agent.py           # Agent SSE 路由
│   │   └── kb.py              # 知识库 CRUD 路由
│   ├── utils/
│   │   ├── llm.py             # LLM/Embedding 实例工厂
│   │   └── mongo.py           # MongoDB 连接管理
│   └── models/
│       └── schemas.py         # Pydantic 数据模型
├── uploads/                   # 临时上传目录（自动清理）
└── data/                      # 本地存储持久化目录
    └── kb-local-store.json    # 本地 JSON 向量存储（MongoDB 不可用时使用）
```

## Agent 状态机

10 节点 LangGraph 流水线：

```
START → plan_query → retrieve → rerank → answer_from_kb → reflect_answer → END
                          ↓                        ↑
                   ask_web_search → search_web → answer_from_web
```

- **plan_query**: LLM 规划检索计划，生成独立检索查询词
- **retrieve**: 向量检索，无结果时触发联网搜索询问
- **rerank**: LLM JSON 重排序（可选，默认关闭）
- **answer_from_kb**: 基于知识库文档流式生成答案
- **reflect_answer**: 答案质量反思，可能触发 rewrite 或联网搜索
- **search_web → answer_from_web**: Tavily 联网搜索分支

## 存储架构

| 场景 | 存储后端 | 数据文件 |
|------|---------|---------|
| MongoDB Atlas 可用 | MongoDB `kb_chunks` / `kb_files` / `conversations` 集合 | Atlas 云端 |
| MongoDB 不可用 | 本地 JSON 模拟 | `data/kb-local-store.json` |

检索器同样支持双轨：
- **atlas_vector**: 使用 MongoDB Atlas `$vectorSearch` 聚合管道
- **app_cosine**: 应用层全量余弦相似度计算（Atlas 故障时自动 5 分钟降级）

## 与 TypeScript 版的差异

| 特性 | TypeScript 版 | Python 版 |
|------|--------------|-----------|
| 框架 | Express | FastAPI |
| Agent | LangGraph TS | LangGraph Python |
| Embedding | text-embedding-3-small | text-embedding-3-small |
| 重排序 | LLM JSON | LLM JSON |
| 文本分割 | 英文分隔符 | 中文自适应分隔符 |
| PDF 加载 | pdf-parse | PyMuPDF |
| 向量存储 | MongoDB Atlas | MongoDB Atlas + 本地 JSON 降级 |
| 联网搜索 | Tavily | Tavily |
