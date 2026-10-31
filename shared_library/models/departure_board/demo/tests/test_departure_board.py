from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("departure_board: the prefab spawns and its model's controls work")
async def test_departure_board(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.departure_board, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("mount", "wall")
    assert model.option("mount") == "wall"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
