"""FastAPI 应用入口 —— CORS、路由挂载、端口冲突自动重试。"""

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings

app = FastAPI(
    title="中文 RAG 后端",
    description="基于 BGE 模型的中文优化 RAG 问答系统",
    version="0.1.0",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"ok": True, "service": "backend-py", "version": "0.1.0"}


# 延迟导入路由（避免循环引用）
def register_routes():
    from src.routes.kb import router as kb_router
    from src.routes.agent import router as agent_router

    app.include_router(kb_router, prefix="/kb")
    app.include_router(agent_router, prefix="/agent")


register_routes()


def listen_with_fallback(port: int, max_attempts: int = 20):
    """端口冲突时自动尝试 +1，最多 max_attempts 次。"""
    import sys

    for attempt in range(max_attempts):
        try:
            uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
            return
        except Exception as e:
            if "address already in use" in str(e).lower() and attempt < max_attempts - 1:
                port += 1
                print(f"端口已占用，尝试端口 {port}...")
            else:
                print(f"启动失败: {e}", file=sys.stderr)
                sys.exit(1)


if __name__ == "__main__":
    listen_with_fallback(settings.PORT)
