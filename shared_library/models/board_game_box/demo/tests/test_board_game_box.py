from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("board_game_box: the prefab spawns and its model's controls work")
async def test_board_game_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.board_game_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 0.045)
    assert abs(model.joint("lid") - 0.045) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
