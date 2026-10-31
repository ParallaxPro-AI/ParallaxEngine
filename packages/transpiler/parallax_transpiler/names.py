"""The names Parallax Python knows: builtins, stdlib shims, method dispatch tables and the
JavaScript words a compiled name must never collide with.

Every table here is a promise that `pyrt` (runtime/src/api/pyrt/) implements the entry
with CPython semantics. Anything absent is a compile error, never a guess.
"""

# Builtin functions and values, by Python name → the pyrt export compiled code uses.
BUILTINS: dict[str, str] = {
    "abs": "abs", "all": "all", "any": "any", "bin": "bin", "bool": "bool", "callable": "callable",
    "chr": "chr", "dict": "dict", "divmod": "divmod", "enumerate": "enumerate", "filter": "filter",
    "float": "float", "format": "format", "frozenset": "frozenset", "getattr": "getattr",
    "hasattr": "hasattr", "hash": "hash", "hex": "hex", "int": "int", "isinstance": "isinstance",
    "issubclass": "issubclass", "iter": "iter", "len": "len", "list": "list", "map": "map",
    "max": "max", "min": "min", "next": "next", "object": "object", "oct": "oct", "ord": "ord",
    "pow": "pow", "print": "print", "range": "range", "repr": "repr", "reversed": "reversed",
    "round": "round", "set": "set", "setattr": "setattr", "sorted": "sorted", "str": "str",
    "sum": "sum", "tuple": "tuple", "type": "type", "zip": "zip",
    "NotImplemented": "NotImplemented", "Ellipsis": "Ellipsis",
    # Exceptions.
    "BaseException": "BaseException", "Exception": "Exception", "ArithmeticError": "ArithmeticError",
    "AssertionError": "AssertionError", "AttributeError": "AttributeError", "IndexError": "IndexError",
    "KeyError": "KeyError", "LookupError": "LookupError", "NameError": "NameError",
    "NotImplementedError": "NotImplementedError", "OverflowError": "OverflowError",
    "RecursionError": "RecursionError", "RuntimeError": "RuntimeError", "StopIteration": "StopIteration",
    "TypeError": "TypeError", "ValueError": "ValueError", "ZeroDivisionError": "ZeroDivisionError",
}

# Builtins that are classes (called with `new`); the other callables are plain functions.
BUILTIN_CLASSES = frozenset({"object"} | {n for n in BUILTINS if n.endswith(("Error", "Exception"))}
                            | {"StopIteration"})

# Builtins that are only meaningful in a fixed syntactic position.
DECORATOR_BUILTINS = frozenset({"property", "staticmethod", "classmethod"})

# Builtins that are names (callable at runtime) and evaluate to a bool when called.
BOOL_BUILTINS = frozenset({"isinstance", "issubclass", "callable", "hasattr", "bool", "any", "all"})

# Rejected builtins with a rewrite (the safety pass already rejects the host escapes).
UNSUPPORTED_BUILTINS: dict[str, str] = {
    "id": "Compare with `is`, or give the object an explicit id field.",
    "dir": "Name the attributes you need directly.",
    "bytes": "Use str; Parallax Python has no byte strings.",
    "bytearray": "Use a list of ints.",
    "complex": "Use two floats or a Vec2.",
    "slice": "Write the slice inline: xs[a:b].",
    "ascii": "Use repr().",
    "aiter": "Use a for loop over a list.",
    "anext": "Use a for loop over a list.",
    "exit": "End the run through the game's flow (ctx.scenes / ctx.game).",
    "quit": "End the run through the game's flow (ctx.scenes / ctx.game).",
    "help": "Read the SDK docs instead.",
    "super": "Use super() only as super().method(...) inside a method.",
    "__name__": "Module names are not available at runtime.",
    "__file__": "File paths are not available at runtime.",
}

# Stdlib shims: module → {member: pyrt expression}. Members absent here are PP6012.
STDLIB: dict[str, dict[str, str]] = {
    "math": {name: f"math.{name}" for name in (
        "pi", "tau", "e", "inf", "nan",
        "sqrt", "exp", "log", "log2", "log10", "pow", "fabs", "floor", "ceil", "trunc",
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
        "hypot", "degrees", "radians", "copysign", "fmod", "isclose", "isfinite", "isinf",
        "isnan", "gcd", "dist", "prod", "factorial",
    )},
    "random": {name: f"random.{name}" for name in (
        "random", "uniform", "randint", "randrange", "choice", "choices", "sample", "shuffle", "gauss",
    )},
    "enum": {"Enum": "enum.Enum"},
    "dataclasses": {"dataclass": "dataclasses.dataclass", "replace": "dataclasses.replace",
                    "field": "dataclasses.field"},
    "typing": {name: f"typing.{name}" for name in (
        "Any", "Callable", "ClassVar", "Final", "Literal", "NamedTuple", "Optional", "Protocol",
        "Sequence", "Iterable", "Iterator", "Mapping", "Union", "TYPE_CHECKING", "Self",
    )},
    "collections": {"deque": "collections.deque", "Counter": "collections.Counter",
                    "defaultdict": "collections.defaultdict"},
    "collections.abc": {name: f"typing.{name}" for name in (
        "Callable", "Iterable", "Iterator", "Mapping", "Sequence",
    )},
}

# Names imported from typing that only mean something inside annotations.
TYPING_GENERICS = frozenset({"Callable", "ClassVar", "Final", "Literal", "Optional", "Union",
                             "Sequence", "Iterable", "Iterator", "Mapping"})

# Python list and str methods. A call `x.name(...)` with one of these names is dispatched by
# pyrt on the receiver's runtime type (JS arrays and strings have no Python methods).
LIST_METHODS = frozenset({
    "append", "extend", "insert", "remove", "pop", "clear", "index", "count", "sort", "reverse", "copy",
})
STR_METHODS = frozenset({
    "capitalize", "center", "count", "endswith", "find", "index", "isalnum", "isalpha", "isascii",
    "isdecimal", "isdigit", "islower", "isnumeric", "isspace", "istitle", "isupper", "join", "ljust",
    "lower", "lstrip", "partition", "removeprefix", "removesuffix", "replace", "rfind", "rindex",
    "rjust", "rpartition", "rsplit", "rstrip", "split", "splitlines", "startswith", "strip",
    "swapcase", "title", "upper", "zfill",
})
DISPATCHED_METHODS = LIST_METHODS | STR_METHODS

# Str methods we reject with a rewrite.
UNSUPPORTED_STR_METHODS: dict[str, tuple[str, str]] = {
    "format": ("PP6107", 'use an f-string: f"Score: {score}"'),
    "format_map": ("PP6107", "use an f-string"),
    "encode": ("PP6021", "Parallax Python has no byte strings; keep the str"),
    "expandtabs": ("PP6021", "replace tabs explicitly: s.replace('\\t', '    ')"),
    "casefold": ("PP6021", "use lower()"),
    "translate": ("PP6021", "use replace() for each character"),
    "maketrans": ("PP6021", "use replace() for each character"),
}

# Members of JavaScript's built-in prototypes that are not Python methods. Compiled code
# reaches them only through pyrt's checked `attr` / `callm`, which raise AttributeError
# when the receiver is a builtin value (or the member is the JS prototype's own).
JS_PROTOTYPE_NAMES = frozenset({
    # Object.prototype
    "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString", "valueOf",
    # Function.prototype
    "apply", "bind", "call", "caller", "arguments", "length", "name",
    # Array.prototype
    "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex",
    "findLast", "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join",
    "keys", "lastIndexOf", "map", "push", "reduce", "reduceRight", "shift", "slice", "some",
    "splice", "toReversed", "toSorted", "toSpliced", "unshift", "values", "with",
    # String.prototype
    "anchor", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt", "endsWith", "fixed",
    "fontcolor", "fontsize", "isWellFormed", "italics", "link", "localeCompare", "match",
    "matchAll", "normalize", "padEnd", "padStart", "repeat", "replaceAll", "search", "small",
    "startsWith", "strike", "sub", "substr", "substring", "sup", "toLocaleLowerCase",
    "toLocaleUpperCase", "toLowerCase", "toUpperCase", "toWellFormed", "trim", "trimEnd",
    "trimLeft", "trimRight", "trimStart",
    # Number.prototype
    "toExponential", "toFixed", "toPrecision",
}) - DISPATCHED_METHODS

# Words that cannot be JS binding names (or would shadow what compiled code relies on).
JS_RESERVED = frozenset({
    "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "enum", "eval", "export", "extends", "false", "finally",
    "for", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
    "null", "package", "private", "protected", "public", "return", "static", "super", "switch",
    "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
    "undefined", "NaN", "Infinity", "globalThis",
})


def js_name(name: str) -> str:
    """A Python identifier as a JS binding name. Python names never contain `$`, so a
    trailing `$` can't collide with another Python name."""
    return f"{name}$" if name in JS_RESERVED else name
