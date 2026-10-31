from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("foosball_table: the prefab spawns and its model's controls work")
async def test_foosball_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.foosball_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("rod_1_slide", 0.0)
    assert abs(model.joint("rod_1_slide") - 0.0) < 1e-3
    model.set_option("team_a", "blue")
    assert model.option("team_a") == "blue"
    assert model.socket_position("ball_drop").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
