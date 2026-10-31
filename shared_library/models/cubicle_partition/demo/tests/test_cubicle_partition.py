from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cubicle_partition: the prefab spawns and its model's controls work")
async def test_cubicle_partition(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cubicle_partition, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("fabric", "grey")
    assert model.option("fabric") == "grey"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
