from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("helipad_marker: the prefab spawns and its model's controls work")
async def test_helipad_marker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.helipad_marker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("surface", "asphalt")
    assert model.option("surface") == "asphalt"
    assert model.socket_position("touchdown").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
