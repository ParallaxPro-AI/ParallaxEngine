from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rail_track_curve: the prefab spawns and its model's controls work")
async def test_rail_track_curve(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rail_track_curve, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("sleepers", "timber")
    assert model.option("sleepers") == "timber"
    assert model.socket_position("joint_a").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
