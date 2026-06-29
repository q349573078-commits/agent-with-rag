"""中文文本分割器 —— 纯 RecursiveCharacterTextSplitter，自适应策略。"""

import re
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
    return re.sub(r"\n{3,}", "\n\n", text).strip()


async def _split_single_document(doc: Document) -> List[Document]:
    """分割单个文档。"""
    base_metadata = dict(doc.metadata) if doc.metadata else {}
    source_type = _get_source_type(base_metadata.get("source"))
    normalized_content = _normalize_chunk(doc.page_content)

    if not normalized_content:
        return []

    chunk_config = _get_chunk_config(len(normalized_content), source_type)

    if not chunk_config:
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
