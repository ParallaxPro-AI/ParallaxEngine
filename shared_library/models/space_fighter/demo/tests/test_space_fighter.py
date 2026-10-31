from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("space_fighter: the prefab spawns and its model's controls work")
async def test_space_fighter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.space_fighter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("canopy", 27.5)
    assert abs(model.joint("canopy") - 27.5) < 1e-3
    model.set_option("hull", "grey")
    assert model.option("hull") == "grey"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
