from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spice_rack_wall: the prefab spawns and its model's controls work")
async def test_spice_rack_wall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spice_rack_wall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("wood_finish", "walnut")
    assert model.option("wood_finish") == "walnut"
    assert model.socket_position("wall_mount").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
