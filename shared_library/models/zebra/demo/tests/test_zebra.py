from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("zebra: the prefab spawns and its model's controls work")
async def test_zebra(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.zebra, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stripes", "brown")
    assert model.option("stripes") == "brown"
    assert model.socket_position("head_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
