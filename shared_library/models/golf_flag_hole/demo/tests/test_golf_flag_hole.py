from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("golf_flag_hole: the prefab spawns and its model's controls work")
async def test_golf_flag_hole(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.golf_flag_hole, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flagstick", 0.25)
    assert abs(model.joint("flagstick") - 0.25) < 1e-3
    model.set_option("flag", "yellow")
    assert model.option("flag") == "yellow"
    assert model.socket_position("socket_cup").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
