from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("farm_produce_stand: the prefab spawns and its model's controls work")
async def test_farm_produce_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.farm_produce_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cash_box_lid", 42.5)
    assert abs(model.joint("cash_box_lid") - 42.5) < 1e-3
    model.set_option("finish", "green")
    assert model.option("finish") == "green"
    assert model.socket_position("socket_counter").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
