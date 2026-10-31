from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("coffee_cup_takeaway: the prefab spawns and its model's controls work")
async def test_coffee_cup_takeaway(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.coffee_cup_takeaway, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 0.03)
    assert abs(model.joint("lid") - 0.03) < 1e-3
    model.set_option("cup", "kraft")
    assert model.option("cup") == "kraft"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
