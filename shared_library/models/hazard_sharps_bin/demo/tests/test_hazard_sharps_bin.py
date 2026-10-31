from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hazard_sharps_bin: the prefab spawns and its model's controls work")
async def test_hazard_sharps_bin(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hazard_sharps_bin, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flap", 52.5)
    assert abs(model.joint("flap") - 52.5) < 1e-3
    model.set_option("lid", "yellow")
    assert model.option("lid") == "yellow"
    assert model.socket_position("drop_in").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
