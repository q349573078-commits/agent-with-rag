"""本地 JSON 文件存储 —— 模拟 MongoDB Collection API。"""

import json
import logging
import math
import os
from bson import ObjectId
from copy import deepcopy

logger = logging.getLogger(__name__)

LOCAL_STORE_PATH = os.path.join(os.getcwd(), "data", "kb-local-store.json")
EMPTY_DATA = {"kb_chunks": [], "kb_files": []}

_data_promise = None


def _load_data():
    """加载本地存储数据。"""
    global _data_promise
    if _data_promise is not None:
        return _data_promise

    try:
        if os.path.exists(LOCAL_STORE_PATH):
            with open(LOCAL_STORE_PATH, "r", encoding="utf-8") as f:
                parsed = json.load(f)
        else:
            parsed = deepcopy(EMPTY_DATA)
    except Exception:
        logger.warning("[localStore] Failed to load, using empty data")
        parsed = deepcopy(EMPTY_DATA)

    # 反序列化 ObjectId
    for key in ("kb_chunks", "kb_files"):
        for doc in parsed.get(key, []):
            if isinstance(doc.get("_id"), str) and ObjectId.is_valid(doc["_id"]):
                doc["_id"] = ObjectId(doc["_id"])

    _data_promise = parsed
    return parsed


def _persist_data(data):
    """持久化数据到 JSON 文件。"""
    os.makedirs(os.path.dirname(LOCAL_STORE_PATH), exist_ok=True)
    disk_data = deepcopy(data)
    for key in ("kb_chunks", "kb_files"):
        for doc in disk_data.get(key, []):
            if isinstance(doc.get("_id"), ObjectId):
                doc["_id"] = str(doc["_id"])

    with open(LOCAL_STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(disk_data, f, ensure_ascii=False, indent=2, default=str)


def _get_path_value(doc, path):
    """获取嵌套字段值，如 'metadata.source'。"""
    for key in path.split("."):
        if isinstance(doc, dict):
            doc = doc.get(key)
        else:
            return None
    return doc


def _set_path_value(doc, path, value):
    """设置嵌套字段值。"""
    keys = path.split(".")
    for key in keys[:-1]:
        if key not in doc or not isinstance(doc[key], dict):
            doc[key] = {}
        doc = doc[key]
    doc[keys[-1]] = value


def _values_equal(left, right):
    """比较两个值是否相等，兼容 ObjectId。"""
    if isinstance(left, ObjectId):
        return str(left) == str(right) if isinstance(right, (ObjectId, str)) else False
    if isinstance(right, ObjectId):
        return str(left) == str(right) if isinstance(left, (ObjectId, str)) else False
    return left == right


def _matches_type(value, type_str):
    """检查值是否匹配指定 BSON 类型。"""
    if type_str == "array":
        return isinstance(value, list)
    if type_str == "string":
        return isinstance(value, str)
    if type_str == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_str == "object":
        return isinstance(value, dict) and not isinstance(value, list)
    return False


def _matches_condition(value, condition):
    """检查值是否匹配条件。"""
    if isinstance(condition, dict):
        for operator, expected in condition.items():
            if operator == "$type":
                if not _matches_type(value, str(expected)):
                    return False
            elif operator == "$exists":
                exists = value is not None
                if exists != bool(expected):
                    return False
            elif operator == "$ne":
                if _values_equal(value, expected):
                    return False
            else:
                return False
        return True

    return _values_equal(value, condition)


def _matches_filter(doc, filter_dict=None):
    """检查文档是否匹配过滤条件。"""
    if not filter_dict:
        return True

    for key, condition in filter_dict.items():
        if key == "$or":
            if not isinstance(condition, list):
                return False
            if not any(_matches_filter(doc, item) for item in condition):
                return False
            continue

        if not _matches_condition(_get_path_value(doc, key), condition):
            return False

    return True


def _apply_projection(doc, projection=None):
    """应用字段投影。"""
    if not projection:
        return deepcopy(doc)

    include_keys = [k for k, v in projection.items() if v == 1]
    if include_keys:
        result = {}
        for key in include_keys:
            val = _get_path_value(doc, key)
            if val is not None:
                _set_path_value(result, key, val)
        if projection.get("_id") != 0 and "_id" in doc:
            result["_id"] = doc["_id"]
        return result

    result = deepcopy(doc)
    for key, v in projection.items():
        if v == 0:
            result.pop(key, None)
    return result


def _cosine_similarity(a, b):
    """计算余弦相似度。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if not norm_a or not norm_b:
        return 0.0
    return dot / (norm_a * norm_b)


class LocalCursor:
    """模拟 MongoDB Cursor 的链式调用。"""

    def __init__(self, docs):
        self._docs = list(docs) if docs else []

    def sort(self, spec):
        """排序，spec 如 {'uploadedAt': -1}。"""
        items = list(self._docs)
        entries = list(spec.items()) if isinstance(spec, dict) else spec

        for key, direction in reversed(entries):
            items.sort(
                key=lambda d: _get_path_value(d, key) if _get_path_value(d, key) is not None else "",
                reverse=(direction == -1),
            )
        self._docs = items
        return self

    def limit(self, n):
        """截取前 n 条。"""
        self._docs = self._docs[:n]
        return self

    def to_list(self, length=None):
        """转换为列表。"""
        result = deepcopy(self._docs)
        if length is not None:
            result = result[:length]
        return result


class LocalKbCollection:
    """本地 JSON 文件存储，模拟 MongoDB Collection API。"""

    isLocalKbCollection = True

    def __init__(self, name):
        self._name = name  # "kb_chunks" or "kb_files"

    # --- 索引 ---
    async def create_index(self, keys, **kwargs):
        return kwargs.get("name", "local_index")

    # --- 查询 ---
    def find(self, filter_dict=None, projection=None):
        data = _load_data()
        docs = [
            _apply_projection(doc, projection)
            for doc in data[self._name]
            if _matches_filter(doc, filter_dict)
        ]
        return LocalCursor(docs)

    async def find_one(self, filter_dict=None, projection=None):
        docs = self.find(filter_dict, projection).limit(1).to_list()
        return docs[0] if docs else None

    # --- 写入 ---
    async def insert_one(self, doc):
        data = _load_data()
        doc = deepcopy(doc)
        if "_id" not in doc:
            doc["_id"] = ObjectId()
        data[self._name].append(doc)
        _persist_data(data)

        class InsertOneResult:
            def __init__(self, inserted_id):
                self.acknowledged = True
                self.inserted_id = inserted_id
        return InsertOneResult(doc["_id"])

    async def insert_many(self, docs):
        data = _load_data()
        for doc in docs:
            doc = deepcopy(doc)
            if "_id" not in doc:
                doc["_id"] = ObjectId()
            data[self._name].append(doc)
        _persist_data(data)

        class InsertManyResult:
            def __init__(self, count):
                self.acknowledged = True
                self.inserted_count = count
        return InsertManyResult(len(docs))

    async def update_one(self, filter_dict, update):
        data = _load_data()
        for doc in data[self._name]:
            if _matches_filter(doc, filter_dict):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_path_value(doc, k, v)
                if "$push" in update:
                    push_data = update["$push"]
                    for k, v in push_data.items():
                        arr = _get_path_value(doc, k) or []
                        if "$each" in v:
                            arr.extend(v["$each"])
                        else:
                            arr.append(v)
                        _set_path_value(doc, k, arr)
                _persist_data(data)

                class UpdateResult:
                    def __init__(self):
                        self.acknowledged = True
                        self.matched_count = 1
                        self.modified_count = 1
                return UpdateResult()

        class UpdateResult:
            def __init__(self):
                self.acknowledged = True
                self.matched_count = 0
                self.modified_count = 0
        return UpdateResult()

    async def delete_one(self, filter_dict):
        data = _load_data()
        for i, doc in enumerate(data[self._name]):
            if _matches_filter(doc, filter_dict):
                data[self._name].pop(i)
                _persist_data(data)

                class DeleteResult:
                    def __init__(self):
                        self.acknowledged = True
                        self.deleted_count = 1
                return DeleteResult()

        class DeleteResult:
            def __init__(self):
                self.acknowledged = True
                self.deleted_count = 0
        return DeleteResult()

    async def delete_many(self, filter_dict):
        data = _load_data()
        before = len(data[self._name])
        data[self._name] = [d for d in data[self._name] if not _matches_filter(d, filter_dict)]
        deleted = before - len(data[self._name])
        if deleted > 0:
            _persist_data(data)

        class DeleteResult:
            def __init__(self):
                self.acknowledged = True
                self.deleted_count = deleted
        return DeleteResult()

    # --- 聚合 ---
    async def count_documents(self, filter_dict=None):
        data = _load_data()
        return sum(1 for d in data[self._name] if _matches_filter(d, filter_dict))

    async def distinct(self, field):
        data = _load_data()
        values = set()
        for doc in data[self._name]:
            val = _get_path_value(doc, field)
            if val is not None:
                values.add(str(val))
        return list(values)

    def aggregate(self, pipeline):
        """支持 $vectorSearch 聚合管道。"""
        data = _load_data()

        vector_search = None
        project = None
        for stage in pipeline:
            if "$vectorSearch" in stage:
                vector_search = stage["$vectorSearch"]
            if "$project" in stage:
                project = stage["$project"]

        if not vector_search:
            return LocalCursor([])

        query_vector = vector_search.get("queryVector", [])
        limit = vector_search.get("limit", 5)

        results = []
        for doc in data[self._name]:
            if not isinstance(doc.get("text"), str):
                continue
            emb = doc.get("embedding")
            if not isinstance(emb, list) or not emb:
                continue

            score = _cosine_similarity(query_vector, emb)
            # 归一化到 [0, 1]
            normalized_score = (max(-1.0, min(1.0, score)) + 1) / 2
            doc_copy = deepcopy(doc)
            doc_copy["score"] = normalized_score
            results.append(doc_copy)

        results.sort(key=lambda d: d["score"], reverse=True)
        results = results[:limit]

        if project:
            results = [_apply_projection(doc, project) for doc in results]

        return LocalCursor(results)


# ---- 预创建实例 ----
_kb_chunks = LocalKbCollection("kb_chunks")
_kb_files = LocalKbCollection("kb_files")


def get_local_kb_collection(name):
    """获取本地存储集合。"""
    if name == "kb_chunks":
        return _kb_chunks
    elif name == "kb_files":
        return _kb_files
    raise ValueError(f"Unknown collection: {name}")


def is_local_kb_collection(collection):
    """检查是否为本地存储集合。"""
    return getattr(collection, "isLocalKbCollection", False)
