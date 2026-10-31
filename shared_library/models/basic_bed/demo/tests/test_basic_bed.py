from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("basic_bed: the prefab spawns and its model's controls work")
async def test_basic_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.basic_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("duvet", "grey")
    assert model.option("duvet") == "grey"
    assert model.socket_position("head_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
