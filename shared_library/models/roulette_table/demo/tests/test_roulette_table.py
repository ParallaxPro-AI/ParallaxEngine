from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("roulette_table: the prefab spawns and its model's controls work")
async def test_roulette_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.roulette_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ball_drop", 0.0575)
    assert abs(model.joint("ball_drop") - 0.0575) < 1e-3
    model.set_option("felt", "blue")
    assert model.option("felt") == "blue"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
