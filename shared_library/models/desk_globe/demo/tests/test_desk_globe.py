from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("desk_globe: the prefab spawns and its model's controls work")
async def test_desk_globe(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.desk_globe, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("ocean", "antique")
    assert model.option("ocean") == "antique"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
