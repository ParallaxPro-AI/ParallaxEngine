from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cheese_board: the prefab spawns and its model's controls work")
async def test_cheese_board(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cheese_board, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("board", "walnut")
    assert model.option("board") == "walnut"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
