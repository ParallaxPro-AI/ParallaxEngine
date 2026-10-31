"""The rules of chess as pure Python: no entities, no context, no engine. The
only SDK import is the pure value type `parallax.values.Cell`.

Everything here works on immutable `Position` values, so the AI can search
thousands of hypothetical positions and the tests can check move generation
without starting a game. The game layer (`game/systems/`) is the only code that
knows pieces are sprites.
"""
