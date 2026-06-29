"""文档加载器 —— PyMuPDF + UTF-8。"""

import os
from typing import List
from langchain_core.documents import Document


def _get_ext(name: str) -> str:
    idx = name.rfind(".")
    return name[idx + 1 :].lower() if idx != -1 else ""


async def load_pdf(file_path: str, original_name: str) -> List[Document]:
    """使用 PyMuPDF 加载 PDF，整篇读取。"""
    import fitz

    doc = fitz.open(file_path)
    total_pages = len(doc)

    texts = []
    for page_num in range(total_pages):
        page = doc.load_page(page_num)
        text = page.get_text()
        if text and text.strip():
            texts.append(text.strip())

    doc.close()

    full_text = "\n\n".join(texts)
    if not full_text.strip():
        return []

    return [
        Document(
            page_content=full_text,
            metadata={
                "source": original_name,
                "totalPages": total_pages,
            },
        )
    ]


async def load_text_or_markdown(file_path: str, original_name: str) -> List[Document]:
    """加载 TXT 或 Markdown 文件，UTF-8 编码。"""
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()

    text = text.strip()
    if not text:
        return []

    return [
        Document(
            page_content=text,
            metadata={"source": original_name},
        )
    ]


async def load_file_as_documents(
    file_path: str,
    mime_type: str,
    original_name: str,
) -> List[Document]:
    """统一入口：根据 MIME 类型或扩展名加载文档。"""
    ext = _get_ext(original_name)

    is_pdf = mime_type == "application/pdf" or ext == "pdf"
    is_markdown = mime_type == "text/markdown" or ext in ("md", "markdown")
    is_text = mime_type == "text/plain" or ext == "txt"

    if is_pdf:
        return await load_pdf(file_path, original_name)
    elif is_text or is_markdown:
        return await load_text_or_markdown(file_path, original_name)
    else:
        raise ValueError(f"不支持的文件格式: {mime_type} ({ext})")
