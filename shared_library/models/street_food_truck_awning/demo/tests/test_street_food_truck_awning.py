from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("street_food_truck_awning: the prefab spawns and its model's controls work")
async def test_street_food_truck_awning(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.street_food_truck_awning, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ledge", 45.0)
    assert abs(model.joint("ledge") - 45.0) < 1e-3
    model.set_option("stripe", "blue")
    assert model.option("stripe") == "blue"
    assert model.socket_position("socket_truck_flank").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
