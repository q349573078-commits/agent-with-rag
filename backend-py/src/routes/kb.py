"""知识库 CRUD API 路由。"""

import asyncio
import hashlib
import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse

from importlib import import_module

_01_loaders = import_module("src.kb.01_loaders")
load_file_as_documents = _01_loaders.load_file_as_documents

_02_splitter = import_module("src.kb.02_splitter")
split_documents = _02_splitter.split_documents

_03_vs = import_module("src.kb.03_vector_store")
get_kb_collection = _03_vs.get_kb_collection
get_kb_files_collection = _03_vs.get_kb_files_collection

_04_ingest = import_module("src.kb.04_ingest")
compute_sha256 = _04_ingest.compute_sha256
ingest_documents = _04_ingest.ingest_documents

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # 20MB
ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md", ".markdown"}
ALLOWED_MIMES = {"application/pdf", "text/plain", "text/markdown"}

UPLOAD_DIR = "uploads"


def _is_supported(filename: str, mime_type: str) -> bool:
    ext = os.path.splitext(filename)[1].lower()
    return ext in ALLOWED_EXTENSIONS or mime_type in ALLOWED_MIMES


def _normalize_name(name: str) -> str:
    return name.strip()


async def _try_decode_filename(raw: str) -> str:
    """尝试解码来自 multipart 的中文文件名。"""
    try:
        return raw.encode("latin1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        pass
    try:
        from urllib.parse import unquote
        return unquote(raw)
    except Exception:
        pass
    return raw


# ---------------------------------------------------------------
# GET /kb/health
# ---------------------------------------------------------------
@router.get("/health")
async def health_check():
    status = {"ok": True}
    try:
        col = await get_kb_collection()
        status["storage"] = {
            "backend": "mongodb",
        }
    except Exception as e:
        status["storage"] = {"backend": "unavailable", "error": str(e)}

    return JSONResponse(status)


# ---------------------------------------------------------------
# GET /kb/files
# ---------------------------------------------------------------
@router.get("/files")
async def list_files():
    try:
        files_col = await get_kb_files_collection()
        kb_col = await get_kb_collection()

        docs = await files_col.find({}).sort("uploadedAt", -1).limit(500).to_list()

        if docs:
            files = []
            for doc in docs:
                oid = None
                if hasattr(doc.get("_id"), "toHexString"):
                    oid = doc["_id"].toHexString()
                elif isinstance(doc.get("_id"), str):
                    oid = doc["_id"]

                files.append({
                    "id": oid,
                    "name": doc.get("originalName") or doc.get("normalizedName", "unknown"),
                    "uploadedAt": str(doc.get("uploadedAt", "")),
                    "chunkCount": doc.get("chunkCount"),
                    "sha256": doc.get("sha256"),
                })
            return JSONResponse({"ok": True, "files": files})

        # 降级：从 chunks 的 source 字段获取文件列表
        sources = await kb_col.distinct("source")
        files = [{"name": s, "legacy": True} for s in sources if isinstance(s, str) and s.strip()]
        return JSONResponse({"ok": True, "legacy": True, "files": files})

    except Exception as e:
        logger.error(f"获取文件列表失败: {e}")
        return JSONResponse(
            {"ok": False, "message": "获取文件列表失败"},
            status_code=500,
        )


# ---------------------------------------------------------------
# GET /kb/files/exists
# ---------------------------------------------------------------
@router.get("/files/exists")
async def check_file_exists(name: str = Query(None), hash: str = Query(None)):
    if not name and not hash:
        return JSONResponse(
            {"ok": False, "message": "Missing query param: provide ?name=... or ?hash=..."},
            status_code=400,
        )

    try:
        files_col = await get_kb_files_collection()
        kb_col = await get_kb_collection()

        normalized_name = _normalize_name(name) if name else None

        if hash:
            doc = await files_col.find_one({"sha256": hash})
            if doc:
                return JSONResponse({
                    "ok": True,
                    "exists": True,
                    "matchBy": "hash",
                    "file": {
                        "name": doc.get("originalName") or doc.get("normalizedName"),
                        "sha256": doc.get("sha256"),
                    },
                })
        else:
            doc = await files_col.find_one(
                {"$or": [{"originalName": normalized_name}, {"normalizedName": normalized_name}]}
            )
            if doc:
                return JSONResponse({
                    "ok": True,
                    "exists": True,
                    "matchBy": "name",
                    "file": {
                        "name": doc.get("originalName") or doc.get("normalizedName"),
                        "sha256": doc.get("sha256"),
                    },
                })

            # legacy 查询
            legacy = await kb_col.find_one({"source": normalized_name})
            if legacy:
                return JSONResponse({
                    "ok": True,
                    "exists": True,
                    "matchBy": "name",
                    "legacy": True,
                    "file": {"name": normalized_name},
                })

        return JSONResponse({
            "ok": True,
            "exists": False,
            "matchBy": "hash" if hash else "name",
        })

    except Exception as e:
        return JSONResponse(
            {"ok": False, "message": str(e)},
            status_code=500,
        )


# ---------------------------------------------------------------
# DELETE /kb/files/:id
# ---------------------------------------------------------------
@router.delete("/files/{file_id}")
async def delete_file_by_id(file_id: str):
    try:
        from bson import ObjectId

        if not ObjectId.is_valid(file_id):
            return JSONResponse(
                {"ok": False, "message": "Invalid file id"},
                status_code=400,
            )

        files_col = await get_kb_files_collection()
        kb_col = await get_kb_collection()

        file_doc = await files_col.find_one({"_id": ObjectId(file_id)})
        if not file_doc:
            return JSONResponse(
                {"ok": True, "deleted": {"files": 0, "chunks": 0}, "notFound": True},
            )

        # 删除关联 chunks
        chunk_filters = [{"metadata.fileId": file_id}]
        sha = file_doc.get("sha256")
        if sha:
            chunk_filters.append({"metadata.sha256": sha})
        chunks_res = await kb_col.delete_many({"$or": chunk_filters})

        # 删除文件记录
        file_res = await files_col.delete_one({"_id": ObjectId(file_id)})

        return JSONResponse({
            "ok": True,
            "deleted": {
                "files": file_res.deleted_count if hasattr(file_res, 'deleted_count') else 1,
                "chunks": chunks_res.deleted_count if hasattr(chunks_res, 'deleted_count') else 0,
            },
        })

    except Exception as e:
        return JSONResponse(
            {"ok": False, "message": str(e)},
            status_code=500,
        )


# ---------------------------------------------------------------
# DELETE /kb/files?name=... or ?hash=...
# ---------------------------------------------------------------
@router.delete("/files")
async def delete_files_by_query(name: str = Query(None), hash: str = Query(None)):
    if not name and not hash:
        return JSONResponse(
            {"ok": False, "message": "Missing query param: provide ?name=... or ?hash=..."},
            status_code=400,
        )

    try:
        files_col = await get_kb_files_collection()
        kb_col = await get_kb_collection()

        normalized_name = _normalize_name(name) if name else None
        normalized_hash = hash.strip() if hash else None

        # 查找文件记录
        file_docs = await files_col.find(
            {"sha256": normalized_hash} if normalized_hash
            else {"$or": [{"originalName": normalized_name}, {"normalizedName": normalized_name}]}
        ).limit(50).to_list()

        # 删除 chunks
        chunk_filters = []
        for doc in file_docs:
            oid = None
            if hasattr(doc.get("_id"), "toHexString"):
                oid = doc["_id"].toHexString()
            elif isinstance(doc.get("_id"), str):
                oid = doc["_id"]
            if oid:
                chunk_filters.append({"metadata.fileId": oid})

        if normalized_hash:
            chunk_filters.append({"metadata.sha256": normalized_hash})
        if normalized_name:
            chunk_filters.append({"source": normalized_name})

        chunks_res = await kb_col.delete_many({"$or": chunk_filters}) if chunk_filters else type("Fake", (), {"deleted_count": 0})()

        # 删除文件记录
        file_res = await files_col.delete_many(
            {"sha256": normalized_hash} if normalized_hash
            else {"$or": [{"originalName": normalized_name}, {"normalizedName": normalized_name}]}
        )

        return JSONResponse({
            "ok": True,
            "deleted": {
                "files": file_res.deleted_count if hasattr(file_res, 'deleted_count') else len(file_docs),
                "chunks": chunks_res.deleted_count if hasattr(chunks_res, 'deleted_count') else 0,
            },
        })

    except Exception as e:
        return JSONResponse(
            {"ok": False, "message": str(e)},
            status_code=500,
        )


# ---------------------------------------------------------------
# POST /kb/upload
# ---------------------------------------------------------------
@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    uploaded_path: Optional[str] = None
    reserved_id: Optional[str] = None
    stage = "receive"

    try:
        # 验证文件类型
        if not _is_supported(file.filename or "", file.content_type or ""):
            raise HTTPException(status_code=400, detail="不支持的文件类型。请上传 PDF、TXT 或 Markdown 文件。")

        # 读取文件内容
        stage = "read"
        content = await file.read()
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=400, detail="文件过大，最大 20MB。")

        # 解码文件名（处理中文）
        stage = "decode"
        decoded_name = await _try_decode_filename(file.filename or "unknown")
        normalized = _normalize_name(decoded_name)

        # 写入临时文件
        stage = "write"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        import tempfile
        tmp = tempfile.NamedTemporaryFile(dir=UPLOAD_DIR, delete=False, suffix=os.path.splitext(decoded_name)[1])
        tmp.write(content)
        tmp.close()
        uploaded_path = tmp.name

        # 计算 SHA-256
        stage = "hash"
        sha256_hash = compute_sha256(uploaded_path)

        # 去重检查
        stage = "dedup"
        files_col = await get_kb_files_collection()

        if sha256_hash:
            existing = await files_col.find_one({"sha256": sha256_hash})
            if existing:
                return JSONResponse({
                    "ok": True,
                    "skipped": True,
                    "reason": "duplicate",
                    "matchBy": "hash",
                    "file": {
                        "name": existing.get("originalName") or existing.get("normalizedName"),
                        "sha256": sha256_hash,
                    },
                })

        # 预创建文件记录
        stage = "reserve"
        from bson import ObjectId
        reserved_id = str(ObjectId())
        try:
            await files_col.insert_one({
                "_id": reserved_id,
                "originalName": decoded_name,
                "normalizedName": normalized,
                "sha256": sha256_hash,
                "uploadedAt": __import__("datetime").datetime.now(),
                "chunkCount": 0,
            })
        except Exception:
            pass  # 重复插入不等于错误

        # 加载 → 分割 → 摄入
        stage = "ingest"
        raw_docs = await load_file_as_documents(uploaded_path, file.content_type or "application/octet-stream", decoded_name)
        if not raw_docs:
            raise ValueError(f"无法从文件提取文本内容: {decoded_name}")
        chunks = await split_documents(raw_docs)
        if not chunks:
            raise ValueError(f"文件分割后无可用 chunk: {decoded_name}")
        summary = await ingest_documents(chunks)

        # 更新文件记录
        stage = "finalize"
        if reserved_id:
            from bson import ObjectId
            try:
                await files_col.update_one(
                    {"_id": ObjectId(reserved_id)},
                    {"$set": {"chunkCount": summary["totalChunks"]}},
                )
            except Exception:
                pass

        return JSONResponse({
            "ok": True,
            "totalChunks": summary["totalChunks"],
            "sources": summary.get("sources", []),
            "file": {
                "id": reserved_id,
                "name": decoded_name,
                "sha256": sha256_hash,
            },
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[kb.upload] stage={stage} error: {e}")
        return JSONResponse(
            {"ok": False, "message": str(e), "stage": stage},
            status_code=500,
        )
    finally:
        # 清理临时文件
        if uploaded_path and os.path.exists(uploaded_path):
            try:
                os.unlink(uploaded_path)
            except Exception:
                pass
