"""Walking orders for NavAgents. `NavAgent.move_to` plans a fresh path on every call
(and a followed entity is re-pathed by the agent itself), and brains re-issue their
orders every frame, often to a point that drifts a little (a bot shadowing its lane's
front line). On the arena's terrain a plan is a real search, so a new order replaces
the current one only when it moves the goal by a noticeable share of the way left."""

from parallax import Entity, Vec3
from parallax.nav import NavAgent

DRIFT = 0.15
"""A new goal within this share of the remaining distance of the current one is the same order."""
SAME_POINT = 0.1
"""Meters: the tolerance close to the goal."""
SAME_CHASE = 1.0
"""Meters: the tolerance for a chase close to its target."""


def walk_to(agent: NavAgent, point: Vec3) -> None:
    here = agent.entity.transform.position
    left = (here - point).flat().length()
    if left <= agent.stopping_distance:
        return
    going = agent.destination
    if going is not None and (going - point).flat().length() <= max(SAME_POINT, DRIFT * left):
        return
    agent.move_to(point)


def chase(agent: NavAgent, target: Entity) -> None:
    there = target.transform.position
    left = (agent.entity.transform.position - there).flat().length()
    going = agent.destination
    if agent.moving and going is not None and (going - there).flat().length() <= max(SAME_CHASE, DRIFT * left):
        return
    agent.move_to(target)
