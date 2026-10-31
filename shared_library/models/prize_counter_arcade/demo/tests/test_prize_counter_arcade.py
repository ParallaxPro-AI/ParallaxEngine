from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("prize_counter_arcade: the prefab spawns and its model's controls work")
async def test_prize_counter_arcade(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.prize_counter_arcade, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("case_door_l", 0.5)
    assert abs(model.joint("case_door_l") - 0.5) < 1e-3
    model.set_option("trim", "red")
    assert model.option("trim") == "red"
    assert model.socket_position("customer").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
