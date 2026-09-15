from dataclasses import dataclass
from typing import NewType

FeatureCode = NewType("FeatureCode", str)


@dataclass(frozen=True, slots=True)
class EntitlementSet:
    features: frozenset[str]

    def has(self, feature_code: str) -> bool:
        return feature_code in self.features

    def serialize(self) -> list[str]:
        return sorted(self.features)
