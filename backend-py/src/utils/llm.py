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
