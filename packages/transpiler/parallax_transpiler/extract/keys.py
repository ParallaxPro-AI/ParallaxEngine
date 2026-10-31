"""Keyboard key names an action may bind: the DOM `KeyboardEvent.code` values."""

KEY_CODES = frozenset(
    [f"Key{chr(c)}" for c in range(ord("A"), ord("Z") + 1)]
    + [f"Digit{d}" for d in range(10)]
    + [f"Numpad{d}" for d in range(10)]
    + [f"F{n}" for n in range(1, 25)]
    + [
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Space", "Enter", "Escape", "Tab", "Backspace", "Delete", "Insert", "Home", "End",
        "PageUp", "PageDown", "CapsLock", "ContextMenu", "PrintScreen", "ScrollLock", "Pause",
        "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
        "MetaLeft", "MetaRight",
        "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote",
        "Backquote", "Comma", "Period", "Slash", "IntlBackslash",
        "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
        "NumpadEnter", "NumpadEqual",
    ]
)
