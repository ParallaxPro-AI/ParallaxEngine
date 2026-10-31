from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("retro_handheld: the prefab spawns and its model's controls work")
async def test_retro_handheld(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.retro_handheld, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("face_colour", "black")
    assert model.option("face_colour") == "black"
    assert model.socket_position("socket_cartridge").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
