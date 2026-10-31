"""The wanted level and the police response.

Crimes are recognised here from other features' events (shots, hits, stolen cars, wrecks); what each
crime is worth, who must witness it, and what turns up at each star are content. Losing line of sight
starts a search; staying unseen long enough loses them. Cornered on foot at low stars, you get BUSTED.
"""

from parallax import Feature
from project import Scenes

from features.police.config import Pursuit
from features.police.content import CrimeDef
from features.police.events import CrimeCommitted, PlayerBusted
from features.police.resources import Phase, Wanted, wanted_level
from features.police.systems import Arrests, Crimes, Dispatch, WantedLevel

police = Feature(
    "police",
    requires=["on_foot", "driving", "city_life"],
    systems=[Crimes, WantedLevel, Dispatch, Arrests],
    scenes=[Scenes.sunset_bay],
    doc="Crimes, witnesses, the five-star wanted level, search, dispatch, pursuit units and arrest.",
)

__all__ = ["CrimeCommitted", "CrimeDef", "Phase", "PlayerBusted", "Pursuit", "Wanted", "police", "wanted_level"]
