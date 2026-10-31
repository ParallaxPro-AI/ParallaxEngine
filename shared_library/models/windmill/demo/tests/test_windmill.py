from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("windmill: the prefab spawns and its model's controls work")
async def test_windmill(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.windmill, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tail", 0.0)
    assert abs(model.joint("tail") - 0.0) < 1e-3
    model.set_option("rotor_kit", "wind_pump")
    assert model.option("rotor_kit") == "wind_pump"
    assert model.socket_position("socket_door").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
