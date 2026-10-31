from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("conference_table: the prefab spawns and its model's controls work")
async def test_conference_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.conference_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch", 50.0)
    assert abs(model.joint("hatch") - 50.0) < 1e-3
    model.set_option("top", "oak")
    assert model.option("top") == "oak"
    assert model.socket_position("hatch_port").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
