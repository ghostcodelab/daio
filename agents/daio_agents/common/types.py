"""Pydantic models mirroring on-chain structs."""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class Allocation(BaseModel):
    tokens: list[str] = Field(min_length=1)
    weights_bps: list[int] = Field(min_length=1)

    @field_validator("weights_bps")
    @classmethod
    def _sum_to_10000(cls, v: list[int]) -> list[int]:
        if sum(v) != 10000:
            raise ValueError(f"weights must sum to 10000 bps, got {sum(v)}")
        return v

    def __init__(self, **data):
        super().__init__(**data)
        if len(self.tokens) != len(self.weights_bps):
            raise ValueError("tokens and weights_bps length mismatch")


class Proposal(BaseModel):
    epoch: int
    allocation: Allocation
    rationale: str
    rationale_hash: str
    signature: str = ""
    # The commit hash is computed via ProposalRound.hashProposal() on-chain to
    # avoid any encoding skew. See common.epoch.commit_for_epoch.
