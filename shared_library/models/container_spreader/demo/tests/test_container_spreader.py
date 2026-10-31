from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("container_spreader: the prefab spawns and its model's controls work")
async def test_container_spreader(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.container_spreader, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("twist_fl", 45.0)
    assert abs(model.joint("twist_fl") - 45.0) < 1e-3
    model.set_option("locks", "locked")
    assert model.option("locks") == "locked"
    assert model.socket_position("socket_reeve").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
