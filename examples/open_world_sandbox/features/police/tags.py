"""Kinds of police unit."""

from parallax import tag

Officer = tag("officer")
Cruiser = tag("cruiser")
Chopper = tag("chopper")
Roadblock = tag("roadblock")
Dispatched = tag("dispatched")
"""Sent by dispatch for this pursuit (and stood down after it); parked police cars never carry it."""
