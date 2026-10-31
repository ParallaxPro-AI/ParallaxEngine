from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("monster_truck: the prefab spawns and its model's controls work")
async def test_monster_truck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.monster_truck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tailgate", 45.0)
    assert abs(model.joint("tailgate") - 45.0) < 1e-3
    model.set_option("paint", "blue")
    assert model.option("paint") == "blue"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
