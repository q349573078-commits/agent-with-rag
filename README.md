## 🚀 快速开始

### 环境要求

- Node.js >= 18
- MongoDB（支持向量搜索）
- OpenAI API Key

### 后端配置

1. 进入后端目录并安装依赖：
```bash
cd backend
npm install
```

2. 配置环境变量（创建 `.env` 文件）：
```env
OPENAI_API_KEY=your_api_key
MONGODB_URI=your_mongodb_uri
PORT=3001
```

3. 启动开发服务器：
```bash
npm run dev
```

### 前端配置

1. 进入前端目录并安装依赖：
```bash
cd frontend
npm install
```

2. 配置环境变量（创建 `.env` 文件）：
```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

3. 启动开发服务器：
```bash
npm run dev
```

## 📚 学习收获

通过本项目，系统掌握了以下技能：

- ✅ LLM 应用开发的完整流程
- ✅ RAG 技术的核心原理与实现
- ✅ 向量数据库的应用与优化
- ✅ LangChain 框架的深度使用
- ✅ 全栈开发能力（TypeScript + Next.js）
- ✅ 生产级代码规范与实践

## 🎯 适用场景

- 企业知识库问答
- 文档智能检索
- 客服自动化
- 私有化知识系统

## 📝 说明

本项目为个人学习实践作品，代码遵循生产级规范，注重类型安全、错误处理和模块化设计，体现了对 AI 工程化的深入理解。

## 📄 License

ISC
