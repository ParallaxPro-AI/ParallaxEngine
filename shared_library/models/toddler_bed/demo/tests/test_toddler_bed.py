from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("toddler_bed: the prefab spawns and its model's controls work")
async def test_toddler_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.toddler_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame", "natural")
    assert model.option("frame") == "natural"
    assert model.socket_position("socket_sleep").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
