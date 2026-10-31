from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("raised_garden_bed: the prefab spawns and its model's controls work")
async def test_raised_garden_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.raised_garden_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("planting", "bare")
    assert model.option("planting") == "bare"
    assert model.socket_position("socket_soil").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
