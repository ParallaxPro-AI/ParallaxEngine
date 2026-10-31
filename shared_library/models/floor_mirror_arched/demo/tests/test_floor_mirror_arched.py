from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("floor_mirror_arched: the prefab spawns and its model's controls work")
async def test_floor_mirror_arched(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.floor_mirror_arched, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame", "brass")
    assert model.option("frame") == "brass"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
