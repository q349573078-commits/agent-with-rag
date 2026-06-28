# Agent with RAG

基于 **LangChain + LangGraph + MongoDB Atlas + Next.js + Electron** 的全栈 RAG 问答系统。支持上传私有文档建立知识库，通过检索增强生成（RAG）进行智能问答，并在知识库不足或问题需要公开实时信息时请求用户确认后联网搜索。提供 Web 端和桌面端（Electron）双端客户端。

## 架构预览

```
用户输入
    │
    ├──────────────────────────┐
    ▼                          ▼
┌──────────────┐    ┌──────────────────┐
│  Next.js     │    │  Electron 桌面端   │
│  Web 端 UI   │    │  (React + Radix)  │
│  (Chat + KB) │    │  Chat + KB 双窗口 │
└──────────────┘    └──────────────────┘
    │                          │
    └──────────┬───────────────┘
               │ SSE / HTTP
               ▼
      ┌──────────────────────┐
      │  Express Server       │
      │  (TypeScript)         │
      │                       │
      │  ┌────────────────┐   │
      │  │  LangGraph      │   │
      │  │  Agent 状态机    │   │
      │  └────────────────┘   │
      │  ┌────────────────┐   │
      │  │  RAG Pipeline   │   │
      │  └────────────────┘   │
      │  ┌────────────────┐   │
      │  │  Web Search     │   │
      │  │  (Tavily)       │   │
      │  └────────────────┘   │
      └──────────────────────┘
               │
    ┌──────────┴──────────┐
    ▼                     ▼
┌──────────────┐    ┌──────────────────┐
│  MongoDB     │    │  OpenAI API       │
│  Atlas       │    │  Embedding + LLM  │
│  向量与历史存储 │    └──────────────────┘
└──────────────┘
```

## 核心特性

### RAG 知识库
- **多格式文档支持**：上传 PDF、TXT、Markdown 文件
- **自适应文本分割**：根据文档长度和类型（PDF/MD/Text）动态调整 chunk 大小和重叠窗口
- **向量化存储**：通过 OpenAI `text-embedding-3-small` 生成嵌入向量，随文本片段存入 MongoDB Atlas
- **智能去重**：前后端双重 SHA-256 哈希校验，避免重复上传
- **语义检索**：默认使用 MongoDB Atlas Vector Search，并保留应用层余弦检索作为降级路径
- **LLM Rerank**：可选的 LLM 重排序，提升检索结果的相关性
- **上传可靠性**：限制单文件 20MB，支持失败回滚、临时文件清理和旧数据兼容

### Agent 智能体（LangGraph 状态机）

Agent 采用有向图状态机驱动，包含以下阶段：

| 阶段 | 说明 |
|------|------|
| `planning` | 分析用户意图，决定是否需要知识库检索和联网搜索 |
| `retrieving` | 执行向量检索，获取相关文档片段 |
| `reranking` | 用 LLM 对检索结果重排序 |
| `answering` | 基于知识库内容生成答案 |
| `web_searching` | 联网搜索（Tavily API） |
| `reflecting` | 自我审查答案质量，必要时重写或发起联网搜索 |

Agent 的核心工作流：

1. **规划（Planning）**：分析用户问题，生成查询计划（意图、是否检索知识库、是否可能需要联网、改写后的检索查询、回答风格、风险等级）
2. **检索（Retrieval）**：从向量知识库检索相关文档
3. **确认（Ask Confirmation）**：知识库结果不足或问题需要公开实时信息时，询问用户是否允许联网搜索
4. **生成（Answering）**：基于知识库或联网结果生成答案
5. **反思（Reflection）**：自我审查答案是否准确、是否完全基于上下文
6. **迭代（Rewrite / Web Search）**：如果答案质量不足，保守重写，或在用户确认后发起联网搜索

### 对话系统
- **SSE 流式响应**：服务器推送逐 token 生成结果，前端实时渲染
- **打字机效果**：前端通过 `requestAnimationFrame` 逐字显示
- **对话历史**：MongoDB 持久化存储，连接失败时降级为内存历史（服务重启后丢失）
- **人工确认联网**：通过 LangGraph interrupt/resume 支持同进程内的联网搜索确认/取消
- **引用标注**：答案附带知识库文档或网页来源引用

### 前端 UI

- **Web 端**：Next.js 16 + React 19，Tailwind CSS v4 样式，shadcn/ui 组件库（Radix UI 原语）
- **桌面端**：Electron + React 19，Tailwind CSS v4 + Radix UI，与 Web 端共享 UI 组件和 hooks
- **知识库管理面板**：上传文件、查看文件列表、删除文件、去重检测（Web 端内嵌页面，桌面端独立窗口）
- **联网搜索确认对话框**：Agent 需要联网时请求用户确认
- **引用展示**：知识库文档和网页来源的链接展示
- **打字机效果**：前端通过 `requestAnimationFrame` 逐字显示

## 技术栈

### 后端

| 技术 | 用途 |
|------|------|
| **Express** | HTTP 服务器，SSE 流式响应 |
| **TypeScript** | 全栈类型安全 |
| **LangChain** | LLM 调用、文档加载、嵌入生成 |
| **LangGraph** | Agent 状态机编排 |
| **MongoDB Atlas** | 知识库向量、文件元数据、对话历史持久化 |
| **OpenAI** | GPT-4o-mini（生成/重排序/反思）、text-embedding-3-small（嵌入） |
| **Tavily** | 联网搜索 API |
| **Multer** | 文件上传处理 |
| **Zod** | 运行时环境变量和数据结构校验 |

### 前端（Web）

| 技术 | 用途 |
|------|------|
| **Next.js 16** | React 框架 |
| **React 19** | UI 构建 |
| **Tailwind CSS v4** | 原子化样式 |
| **Radix UI** | 无障碍 UI 原语 |
| **Lucide React** | 图标库 |
| **class-variance-authority** | 组件样式变体管理 |

### 桌面端

| 技术 | 用途 |
|------|------|
| **Electron** | 桌面应用框架 |
| **electron-vite** | 构建工具 |
| **React 19** | UI 构建 |
| **Tailwind CSS v4** | 原子化样式 |
| **Radix UI** | 无障碍 UI 原语 |
| **electron-builder** | 跨平台打包（macOS/Windows/Linux） |

## 快速开始

### 环境要求

- **Node.js** >= 20.9（Next.js 16 要求）
- **MongoDB Atlas** 集群
- **OpenAI API Key**
- **Tavily API Key**（可选，用于联网搜索）

### 1. 启动后端

```bash
cd backend
npm install
```

创建 `backend/.env` 文件：

```env
OPENAI_API_KEY=sk-your-openai-key
MONGODB_ATLAS_URI=mongodb+srv://your-cluster.mongodb.net
MONGODB_DB_NAME=your-db-name
PORT=5000

# 可选：联网搜索
TAVILY_API_KEY=tvly-your-tavily-key

# 可选：检索调优
RETRIEVAL_MIN_SCORE=0.5
RETRIEVAL_LOW_CONFIDENCE_THRESHOLD=0.6
RETRIEVAL_BACKEND=atlas_vector
KB_VECTOR_INDEX_NAME=kb_vector_index
VECTOR_SEARCH_NUM_CANDIDATES=100
RERANK_ENABLED=false
RERANK_CANDIDATES=20
RERANK_TOP_K=4
```

启动开发服务器：

```bash
npm run dev
```

服务默认运行在 `http://localhost:5000`，端口被占用时会自动尝试下一个端口。如果后端实际运行在 `5001`、`5002` 等回退端口，需要同步修改前端的 `NEXT_PUBLIC_API_BASE_URL`。

### 2. 启动前端

```bash
cd frontend
npm install
```

创建 `frontend/.env` 文件：

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:5000
```

启动开发服务器：

```bash
npm run dev
```

### 3. 启动桌面端

桌面端基于 Electron，提供 Chat 和知识库管理双窗口，启动时会自动拉起后端服务。

```bash
cd desktop
npm install
npm run dev
```

开发环境会通过 `electron-vite dev` 启动，自动打开 Electron 窗口并连接后端 API。

构建分发版本：

```bash
cd desktop
npm run build    # 构建渲染进程
npm run preview # 预览构建产物的桌面应用
```

跨平台打包（macOS dmg/zip、Windows nsis、Linux AppImage）：

```bash
npx electron-builder
```

打包产物输出到 `desktop/release/` 目录。

> 桌面端自动管理后端进程：开发模式下通过 `npx tsx` 启动后端，生产构建后通过 `node dist/index.js` 启动。

### 4. 检索实现说明

当前版本会将文本片段和 embedding 存入 MongoDB Atlas，并默认通过 Atlas `$vectorSearch` 在数据库侧执行向量检索，避免后端全表读取 embedding 后再计算相似度。需要在 Atlas 中为 `kb_chunks` 集合创建 Vector Search index：

- 索引名称：`kb_vector_index`（可通过 `KB_VECTOR_INDEX_NAME` 修改）
- 向量字段：`embedding`
- 维度：`1536`（匹配 `text-embedding-3-small`）
- 相似度：`cosine`

Atlas Vector Search index definition 示例：

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1536,
      "similarity": "cosine"
    }
  ]
}
```

如果 Atlas Vector Search 索引未配置或当前环境不支持 `$vectorSearch`，服务会记录 warning，并在短时间内临时降级到应用层余弦检索，避免每次请求都重复触发失败的 `$vectorSearch`。也可以通过 `RETRIEVAL_BACKEND=app_cosine` 显式使用旧检索路径。`RETRIEVAL_MIN_SCORE` 和 `RETRIEVAL_LOW_CONFIDENCE_THRESHOLD` 使用原始 cosine 语义；Atlas 返回的归一化分数会在服务端转回 cosine 后再参与阈值判断。

## 项目结构

```
agent-with-rag/
├── backend/
│   ├── src/
│   │   ├── agent/
│   │   │   ├── 01_policy.ts          # Agent 系统提示词
│   │   │   ├── 02_agent.ts           # LangGraph Agent 状态机定义
│   │   │   └── 03_memory.ts          # 对话历史管理（MongoDB + 内存回退）
│   │   ├── kb/
│   │   │   ├── 01_loaders.ts         # 文档加载（PDF/TXT/MD）
│   │   │   ├── 02_splitter.ts        # 自适应文本分割
│   │   │   ├── 03_vectorStore.ts     # MongoDB 集合与向量存储封装
│   │   │   ├── 04_ingest.ts          # 文档嵌入与入库
│   │   │   └── 05_retriever.ts       # Atlas Vector Search 检索 + 应用层余弦降级
│   │   ├── routes/
│   │   │   ├── agent.ts              # Agent 对话 SSE 端点
│   │   │   └── kb.ts                 # 知识库管理 CRUD 端点
│   │   ├── types/
│   │   │   └── kb.ts                 # 类型定义
│   │   ├── utils/
│   │   │   ├── env.ts                # 环境变量校验（Zod）
│   │   │   ├── mongo.ts              # MongoDB 客户端 + DNS 劫持检测
│   │   │   └── openai.ts             # LLM / Embedding 模型实例
│   │   └── index.ts                  # Express 服务入口
│   ├── package.json
│   └── tsconfig.json
├── desktop/                          # Electron 桌面端
│   ├── electron/
│   │   ├── main.ts                   # 主进程（启动后端、管理窗口）
│   │   └── preload/
│   │       ├── kb.preload.ts         # 知识库窗口 preload
│   │       └── main.preload.ts       # 主窗口 preload
│   ├── src/
│   │   ├── main/                     # 主窗口（对话）
│   │   │   ├── components/           # ChatArea, ChatRow 等
│   │   │   ├── hooks/                # use-agent-chat
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   ├── kb/                       # 知识库管理窗口
│   │   │   ├── components/           # KbFileList, KbUpload 等
│   │   │   ├── hooks/                # use-kb-files
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   └── shared/                   # 与 Web 前端共享的代码
│   │       ├── components/ui/        # shadcn/ui 组件
│   │       ├── hooks/                # use-typewriter
│   │       ├── lib/                  # SSE 客户端、工具函数
│   │       └── types/                # 类型定义
│   ├── electron.vite.config.ts
│   ├── electron-builder.yml
│   ├── main.html
│   ├── kb.html
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx            # 根布局
│   │   │   ├── page.tsx              # 聊天 + 知识库管理主页面
│   │   │   └── globals.css           # Tailwind 全局样式
│   │   ├── components/ui/            # shadcn/ui 组件
│   │   ├── hooks/
│   │   │   └── use-typewriter.ts     # 打字机效果 Hook
│   │   └── lib/
│   │       └── utils.ts             # 工具函数
│   ├── package.json
│   └── next.config.ts
└── README.md
```

## API 端点

### Agent 对话

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/agent/chat` | 发送消息，返回 SSE 流式响应 |

SSE 事件类型：

| 事件 | 说明 |
|------|------|
| `thread` | 返回 threadId |
| `status` | 当前 Agent 阶段状态 |
| `chunk` | 逐 token 生成内容 |
| `action_required` | Agent 需要用户确认（如联网搜索） |
| `done` | 回答完成，附带完整答案和引用 |
| `error` | 错误信息 |

### 知识库管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/kb/health` | 健康检查 |
| GET | `/kb/files` | 获取文件列表 |
| POST | `/kb/upload` | 上传文件 |
| GET | `/kb/files/exists?name=...` 或 `/kb/files/exists?hash=...` | 检查文件是否已存在 |
| DELETE | `/kb/files/:id` | 按 ID 删除文件 |
| DELETE | `/kb/files?name=...` 或 `/kb/files?hash=...` | 按名称或哈希删除文件 |

## 环境变量说明

| 变量 | 必须 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENAI_API_KEY` | 是 | - | OpenAI API 密钥 |
| `MONGODB_ATLAS_URI` | 是 | - | MongoDB Atlas 连接 URI |
| `MONGODB_DB_NAME` | 是 | - | 数据库名称 |
| `PORT` | 否 | `5000` | 服务端口 |
| `TAVILY_API_KEY` | 否 | - | Tavily 联网搜索 API 密钥 |
| `RERANK_ENABLED` | 否 | `false` | 是否启用 LLM 重排序 |
| `RERANK_CANDIDATES` | 否 | `20` | 重排序候选数 |
| `RERANK_TOP_K` | 否 | `4` | 最终保留的 top K 结果 |
| `RETRIEVAL_MIN_SCORE` | 否 | `0.5` | 检索最低相似度阈值 |
| `RETRIEVAL_LOW_CONFIDENCE_THRESHOLD` | 否 | `0.6` | 低置信度判定阈值 |
| `RETRIEVAL_BACKEND` | 否 | `atlas_vector` | 检索后端：`atlas_vector` 或 `app_cosine` |
| `KB_VECTOR_INDEX_NAME` | 否 | `kb_vector_index` | Atlas Vector Search 索引名称 |
| `VECTOR_SEARCH_NUM_CANDIDATES` | 否 | `100` | Atlas Vector Search 候选池大小下限，实际会取该值与 `k * 20` 的较大值 |

## License

ISC
