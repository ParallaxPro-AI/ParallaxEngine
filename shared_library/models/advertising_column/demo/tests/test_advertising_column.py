from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("advertising_column: the prefab spawns and its model's controls work")
async def test_advertising_column(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.advertising_column, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("paint", "black")
    assert model.option("paint") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
