# 简历项目描述更新 — 融入 Desktop 模块

## 需求

在原有简历项目描述（未含 desktop 模块）基础上，融入 Electron 桌面端模块的内容，更新项目简介、核心职责、项目业绩和技术栈。

## 目标场景

面向全栈/前端岗位和 AI/LLM 应用岗位，一份统一描述，篇幅与原文接近。

## 格式

方案一（增量追加）：在原文 6 个要点结构上融入 desktop 能力，新增 1 个要点，总计 6 点。

---

## 一、项目总述

设计并实现了一个面向私有文档问答场景的 AI Agent 系统，支持用户上传 PDF、TXT、Markdown 等知识库文件，系统自动完成文档解析、切分、向量化入库，并基于对话上下文进行检索增强生成。项目通过 LangGraph 编排多阶段 Agent 工作流，结合知识库检索、LLM 重排序、答案反思、低置信度联网搜索确认和 SSE 流式响应，构建了一个具备工程化闭环的 RAG 问答应用，并基于 Electron 提供跨平台桌面客户端。

## 二、核心职责与实现

● 负责 AI Chatbot 全端交互与 Agent 后端架构设计，基于 Next.js + React 构建 Web 端聊天窗口、知识库管理、引用展示、联网搜索确认等界面，并基于 LangGraph 编排多阶段 Agent 工作流；同时使用 Electron 实现跨平台桌面客户端，通过双窗口架构（对话 + 知识库）和 IPC 通信提供原生桌面体验。

● 基于 SSE 实现大模型 token 级流式输出，通过状态事件驱动 UI 变化，支持打字机效果、检索状态、用户确认、错误提示与中断恢复。

● 设计 RAG 知识库管线，支持 PDF / TXT / Markdown 上传、内容解析、自适应递归切分、Embedding 生成、MongoDB Atlas 向量存储、相似度检索、LLM rerank 与答案反思机制，降低幻觉和上下文外回答风险。

● 设计低置信度场景下的人机确认与多轮对话机制，通过 threadId 维护上下文记忆，在知识库无结果或置信度不足时中断流程，并由用户确认是否启用 Tavily 联网搜索。

● 实现知识库文件管理与多端工程稳定性能力，包括文件大小/类型校验、前后端双重 SHA-256 去重、文件列表查询、文档删除、Zod 运行时校验，以及 MongoDB 连接、DNS 异常、文件上传异常和客户端中断处理。

● 实现 Electron 桌面端工程化能力，包括主进程自动管理后端生命周期（启动/终止）、electron-vite 构建工具链，以及基于 electron-builder 的跨平台打包（macOS dmg/zip、Windows NSIS、Linux AppImage）。

## 三、项目业绩

● 完成从文档上传、解析切分、向量入库、检索召回、引用展示到 SSE 流式问答的完整 RAG 工程闭环，并基于 Next.js 和 Electron 分别交付 Web 端与跨平台桌面端，形成可演示的 AI Chatbot 产品。

● 通过 LLM rerank、答案反思、低置信度判断和用户确认机制，降低知识库无结果或上下文不足时的幻觉风险。

● 采用模块化设计拆分 agent / kb / routes / utils / desktop 等职责，并实现 Web 与桌面端共享 UI 组件和业务 Hooks，便于后续扩展更多工具、检索策略和企业知识库场景。

## 四、主要技术栈

TypeScript、Node.js、Express、Next.js、React、Electron、LangChain、LangGraph、OpenAI API、MongoDB Atlas Vector Search、Tavily Search、SSE、Zod、Multer、Tailwind CSS、Radix UI

---

## 变更对照

| 部分 | 原文 | 更新后 | 变更说明 |
|------|------|--------|---------|
| 总述 | 构建了一个具备工程化闭环的 RAG 问答应用 | 构建了一个具备工程化闭环的 RAG 问答应用，并基于 Electron 提供跨平台桌面客户端 | 末尾追加一句 |
| 第1点 | 负责 AI Chatbot 前端交互与 Agent 后端架构设计，使用 Next.js + React 构建聊天窗口... | 负责 AI Chatbot 全端交互...基于 Next.js + React 构建 Web 端...同时使用 Electron 实现跨平台桌面客户端，通过双窗口架构和 IPC 通信提供原生桌面体验 | "前端"→"全端"，追加 Electron 内容 |
| 第2点 | 不变 | 不变 | - |
| 第3点 | ...递归切分... | ...自适应递归切分... | 加"自适应" |
| 第4点 | 不变 | 不变 | - |
| 第5点 | ...工程稳定性能力，包括文件大小/类型校验、SHA-256 去重... | ...多端工程稳定性能力，包括文件大小/类型校验、前后端双重 SHA-256 去重... | 加"多端"、"前后端双重" |
| 第6点 | 无 | 实现 Electron 桌面端工程化能力... | 新增 |
| 技术栈 | TypeScript、Node.js、Express、Next.js、React、LangChain... | TypeScript、Node.js、Express、Next.js、React、Electron、LangChain...Radix UI | 新增 Electron、Radix UI |
| 业绩第1点 | ...形成可演示的 AI Chatbot 产品 | ...并基于 Next.js 和 Electron 分别交付 Web 端与跨平台桌面端，形成可演示的 AI Chatbot 产品 | 追加双端交付 |
| 业绩第2点 | 不变 | 不变 | - |
| 业绩第3点 | ...拆分 agent / kb / routes / utils 等职责... | ...拆分 agent / kb / routes / utils / desktop 等职责，并实现 Web 与桌面端共享 UI 组件和业务 Hooks... | 加 desktop，补充共享设计 |
