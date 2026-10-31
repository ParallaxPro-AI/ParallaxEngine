"""Line tables and standard (v3) source maps for compiled modules.

The emit pass tags the first JS line of every statement and function with the Python
line it came from (`line_mark`); `strip_marks` removes the tags and returns, per JS line,
the Python line (0 = none, e.g. imports and hoisted constants). Lines without a tag
continue the statement above them. `source_map` encodes the table as a v3 map: one
segment per mapped line, at column 0 of both files.
"""

import json
import re

MARK = "\x00"  # never in emitted JS: json.dumps escapes it, and Python source can't hold it
_MARK = re.compile("\x00(\\d+)\x00")
_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def line_mark(line: int) -> str:
    return f"{MARK}{line}{MARK}"


def strip_marks(text: str) -> tuple[str, list[int]]:
    """(the JS without tags, the Python line of each JS line)."""
    out: list[str] = []
    lines: list[int] = []
    current = 0
    for js_line in text.split("\n"):
        marks = [int(m) for m in _MARK.findall(js_line)]
        lines.append(marks[0] if marks else current if js_line else 0)
        if marks:
            current = marks[-1]
        out.append(_MARK.sub("", js_line) if marks else js_line)
    return "\n".join(out), lines


def vlq(value: int) -> str:
    """Base64 VLQ, as source maps encode every number."""
    n = (-value << 1) | 1 if value < 0 else value << 1
    digits = ""
    while True:
        digit = n & 31
        n >>= 5
        digits += _B64[digit | (32 if n else 0)]
        if not n:
            return digits


def mappings(lines: list[int]) -> str:
    """`mappings` for a table of 1-based Python lines (0 = unmapped) on one source."""
    groups: list[str] = []
    previous = 0  # 0-based source line of the previous segment
    for line in lines:
        if line <= 0:
            groups.append("")
            continue
        # [generated column, source index delta, source line delta, source column delta]
        groups.append(vlq(0) + vlq(0) + vlq(line - 1 - previous) + vlq(0))
        previous = line - 1
    return ";".join(groups)


def source_map(js_file: str, source: str, source_text: str, lines: list[int]) -> str:
    """A v3 source map: `js_file` (the map's `file`) from `source` (relative to the map)."""
    return json.dumps({
        "version": 3,
        "file": js_file,
        "sources": [source],
        "sourcesContent": [source_text],
        "names": [],
        "mappings": mappings(lines),
    }) + "\n"


def map_comment(map_file: str) -> str:
    return f"//# sourceMappingURL={map_file}\n"
