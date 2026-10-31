from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("asylum_restraint_chair: the prefab spawns and its model's controls work")
async def test_asylum_restraint_chair(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.asylum_restraint_chair, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cuff_l", 75.0)
    assert abs(model.joint("cuff_l") - 75.0) < 1e-3
    model.set_option("wood", "oak")
    assert model.option("wood") == "oak"
    assert model.socket_position("seat_main").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
