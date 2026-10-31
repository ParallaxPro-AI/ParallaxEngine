from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pot_rack_hanging: the prefab spawns and its model's controls work")
async def test_pot_rack_hanging(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pot_rack_hanging, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame_finish", "brass")
    assert model.option("frame_finish") == "brass"
    assert model.socket_position("ceiling_mount").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
