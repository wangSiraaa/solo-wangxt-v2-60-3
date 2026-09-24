"""FastAPI 入口与统一错误处理。"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api import handovers, jobs, workers
from app.db import init_db
from app.domain.errors import DomainError


def create_app(run_init: bool = True) -> FastAPI:
    app = FastAPI(
        title="作业关键岗位交接服务",
        version="1.0.0",
        description=(
            "作业进行中关键岗位（负责人/安全员/联络员/防护员）交接。\n\n"
            "核心规则：\n"
            "- 仅 **ACTIVE** 作业可发起交接；销记（CLOSED）后不得再交接；\n"
            "- 必须 **交班人 + 接班人双向确认**，确认瞬间复验接班人到岗、"
            "资质覆盖剩余作业窗口、未占用其他必需岗位；\n"
            "- 责任切换在单个数据库事务内原子完成，不存在必需岗位短暂无人负责；\n"
            "- 同一岗位至多一条未决交接；重复确认幂等、并发完成只形成一次交接；\n"
            "- 超时后迟到确认一律拒绝；责任快照、拒绝原因、超时状态、模拟回执全程留痕；\n"
            "- 销记记录固化最终责任人与交接链；审计顺序持久化，重启后一致。"
        ),
    )

    @app.exception_handler(DomainError)
    async def domain_error_handler(_: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "details": exc.details,
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "REQUEST_VALIDATION_ERROR",
                    "message": "请求参数校验失败",
                    "details": {"errors": exc.errors()},
                }
            },
        )

    app.include_router(workers.router)
    app.include_router(jobs.router)
    app.include_router(handovers.router)

    @app.get("/healthz", tags=["meta"], summary="健康检查")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    if run_init:
        init_db()

    return app


app = create_app()
