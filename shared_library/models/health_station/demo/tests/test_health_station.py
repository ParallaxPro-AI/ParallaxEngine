from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("health_station: the prefab spawns and its model's controls work")
async def test_health_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.health_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("charge", 0.515)
    assert abs(model.joint("charge") - 0.515) < 1e-3
    model.set_option("mount", "wall")
    assert model.option("mount") == "wall"
    assert model.socket_position("socket_dispense").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
