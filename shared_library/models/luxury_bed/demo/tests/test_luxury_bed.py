from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("luxury_bed: the prefab spawns and its model's controls work")
async def test_luxury_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.luxury_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("style", "platform")
    assert model.option("style") == "platform"
    assert model.socket_position("sleep_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
