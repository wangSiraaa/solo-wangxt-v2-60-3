"""导出 OpenAPI 规范到 docs/openapi.json 与 docs/openapi.yaml。

用法：python -m scripts.export_openapi
"""
from __future__ import annotations

import json
from pathlib import Path

from app.main import create_app

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"


def main() -> None:
    app = create_app(run_init=False)
    schema = app.openapi()

    # 统一补充 4xx 业务错误响应（规范完整，便于消费方生成处理逻辑）
    error_schema = {
        "description": "业务错误",
        "content": {
            "application/json": {
                "schema": {
                    "type": "object",
                    "properties": {
                        "error": {
                            "type": "object",
                            "properties": {
                                "code": {"type": "string"},
                                "message": {"type": "string"},
                                "details": {"type": "object"},
                            },
                            "required": ["code", "message"],
                        }
                    },
                }
            }
        },
    }
    for path_item in schema["paths"].values():
        for operation in path_item.values():
            if not isinstance(operation, dict) or "responses" not in operation:
                continue
            responses = operation["responses"]
            for code in ("400", "404", "409", "422"):
                responses.setdefault(code, dict(error_schema))

    DOCS_DIR.mkdir(exist_ok=True)
    json_path = DOCS_DIR / "openapi.json"
    json_path.write_text(
        json.dumps(schema, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    try:
        import yaml
    except ImportError:
        print("pyyaml 未安装，仅生成 openapi.json")
    else:
        (DOCS_DIR / "openapi.yaml").write_text(
            yaml.safe_dump(schema, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )

    print(f"written: {json_path} ({len(schema['paths'])} paths)")


if __name__ == "__main__":
    main()
