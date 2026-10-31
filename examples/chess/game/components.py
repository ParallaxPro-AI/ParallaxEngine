from parallax import tag

Piece = tag("piece")
"""A piece sprite. Its `GridCell` is the square it is drawn on; the authoritative
board is `Match.position`, and pieces only mirror it."""

Highlight = tag("highlight")
"""Selection ring and move dots for the piece the player picked up."""

MoveMarker = tag("move_marker")
"""Last-move squares and the check ring."""
