from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("market_stall_tech: the prefab spawns and its model's controls work")
async def test_market_stall_tech(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.market_stall_tech, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("case_rear_door", 0.45)
    assert abs(model.joint("case_rear_door") - 0.45) < 1e-3
    model.set_option("neon_a", "cyan")
    assert model.option("neon_a") == "cyan"
    assert model.socket_position("seat_keeper").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
