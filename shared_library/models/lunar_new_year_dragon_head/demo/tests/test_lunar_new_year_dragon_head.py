from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lunar_new_year_dragon_head: the prefab spawns and its model's controls work")
async def test_lunar_new_year_dragon_head(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lunar_new_year_dragon_head, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("jaw", 15.0)
    assert abs(model.joint("jaw") - 15.0) < 1e-3
    model.set_option("scheme", "red")
    assert model.option("scheme") == "red"
    assert model.socket_position("mouth").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
