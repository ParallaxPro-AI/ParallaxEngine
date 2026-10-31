from parallax import Entity, System, on, system
from parallax.grid import GridCell
from project import Assets, Prefabs, Scenes, Text

from game.board import HUMAN, board, center, position
from game.chess.moves import captured_square, find_move, in_check, king_square, rook_hop
from game.chess.position import Position, cell_of
from game.components import MoveMarker, Piece
from game.config import Rules, Setup, Sounds
from game.events import MatchStarted, MoveMade
from game.resources import Match


@system("board_view", scenes=[Scenes.title, Scenes.board])
class BoardView(System):
    """Draws the board and the position: lays the 64 squares from the board's
    `Grid` (the title screen sits over the empty board too), sets out the piece sprites, slides them as moves land, and marks the
    last move and a king in check. Reads the match; never changes it."""

    def start(self, ctx):
        grid = board(ctx)
        for cell in grid.cells():
            tile = Prefabs.square_dark if (cell.col + cell.row) % 2 == 0 else Prefabs.square_light
            ctx.world.spawn(tile, at=grid.center(cell).xy())

    @on(MatchStarted)
    def set_out(self, ctx, event):
        for square, piece in enumerate(position(ctx).board):
            if piece:
                spawn_piece(ctx, piece, square)

    @on(MoveMade)
    def show_move(self, ctx, event: MoveMade):
        before = Position.from_fen(event.before)
        move = find_move(before, event.move)
        after = position(ctx)
        seconds = ctx.config(Rules).slide_seconds

        mover = piece_on(ctx, move.origin)
        victim = piece_on(ctx, captured_square(move))
        rook = piece_on(ctx, rook_hop(move)[0]) if move.castle else None

        if victim:
            ctx.vfx.play(Assets.vfx.capture_burst, at=victim.transform.position)
            ctx.camera.main.shake(0.1, 0.13)
            victim.destroy()
        if move.promotion:
            mover.destroy()
            spawn_piece(ctx, after.board[move.target], move.target)
        else:
            slide(ctx, mover, move.target, seconds)
        if rook:
            slide(ctx, rook, rook_hop(move)[1], seconds)

        sounds = ctx.config(Sounds)
        ctx.audio.play(sounds.capture if victim else sounds.move, volume=0.45 if victim else 0.32)
        if in_check(after):
            ctx.audio.play(sounds.check, volume=0.4)
            match = ctx.get(Match)
            match.banner = ctx.text(Text.check_you if after.turn == HUMAN else Text.check_them)
            match.banner_at = ctx.time.now
        self.mark(ctx, move.origin, move.target, after)

    def mark(self, ctx, origin: int, target: int, after: Position):
        for marker in ctx.world.query(tagged=MoveMarker):
            marker.destroy()
        for square in (origin, target):
            ctx.world.spawn(Prefabs.last_move, at=center(ctx, square))
        if in_check(after):
            ctx.world.spawn(Prefabs.check_marker, at=center(ctx, king_square(after.board, after.turn)))


def spawn_piece(ctx, piece: str, square: int) -> Entity:
    prefab = ctx.config(Setup).pieces[piece]
    return ctx.world.spawn(prefab, at=center(ctx, square), components=[GridCell(cell=cell_of(square))])


def piece_on(ctx, square: int) -> Entity | None:
    return board(ctx).first_at(cell_of(square), tagged=Piece)


def slide(ctx, entity: Entity, square: int, seconds: float):
    entity.get(GridCell).cell = cell_of(square)
    entity.transform.move_to(center(ctx, square), seconds, ease="out_quad")
