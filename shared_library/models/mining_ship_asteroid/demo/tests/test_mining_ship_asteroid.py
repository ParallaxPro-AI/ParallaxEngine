from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mining_ship_asteroid: the prefab spawns and its model's controls work")
async def test_mining_ship_asteroid(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mining_ship_asteroid, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drill_arm", -2.5)
    assert abs(model.joint("drill_arm") - -2.5) < 1e-3
    model.set_option("hull", "yellow")
    assert model.option("hull") == "yellow"
    assert model.socket_position("socket_pilot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
