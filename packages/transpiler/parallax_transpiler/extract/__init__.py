"""The declarations pass (contract C2): read every decorator and declaration in
a project statically and write `build/declarations.json` for `parallax check` and the api
layer. Standard library only."""

from parallax_transpiler.extract.document import extract_project

__all__ = ["extract_project"]
