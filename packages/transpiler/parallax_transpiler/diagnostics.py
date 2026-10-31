"""The shared diagnostic shape (mirrors `Diagnostic` in @parallax/runtime/core)."""

from dataclasses import dataclass

DOCS_BASE = "https://parallaxpro.ai/docs/engine/errors/"


@dataclass(frozen=True)
class Diagnostic:
    code: str
    message: str
    path: str
    line: int
    column: int
    fix: str | None = None
    severity: str = "error"

    @property
    def docs(self) -> str:
        return f"{DOCS_BASE}{self.code}"

    def format(self) -> str:
        lines = [f"{self.code}  {self.message}", f"  at {self.path}:{self.line}:{self.column}"]
        if self.fix:
            lines.append(f"  Fix: {self.fix}")
        lines.append(f"  Docs: {self.docs}")
        return "\n".join(lines)

    def to_json(self) -> dict[str, object]:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "path": self.path,
            "line": self.line,
            "column": self.column,
            "fix": self.fix,
            "docs": self.docs,
        }
