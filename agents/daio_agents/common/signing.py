"""EIP-712 signing helpers for Daio proposals.

TODO: align the typed-data definition with the final on-chain PROPOSAL_TYPEHASH
after the Jun 1 ERC-8004 workshop. The structure below is a placeholder.
"""
from __future__ import annotations

from eth_account.messages import encode_typed_data
from eth_account.signers.local import LocalAccount

from .types import Proposal

DOMAIN_NAME = "Daio"
DOMAIN_VERSION = "1"


def domain(chain_id: int, verifying_contract: str) -> dict:
    return {
        "name": DOMAIN_NAME,
        "version": DOMAIN_VERSION,
        "chainId": chain_id,
        "verifyingContract": verifying_contract,
    }


def proposal_typed_data(proposal: Proposal, chain_id: int, verifying_contract: str) -> dict:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Proposal": [
                {"name": "epoch", "type": "uint256"},
                {"name": "tokens", "type": "address[]"},
                {"name": "weightsBps", "type": "uint16[]"},
                {"name": "rationaleHash", "type": "bytes32"},
            ],
        },
        "primaryType": "Proposal",
        "domain": domain(chain_id, verifying_contract),
        "message": {
            "epoch": proposal.epoch,
            "tokens": proposal.allocation.tokens,
            "weightsBps": proposal.allocation.weights_bps,
            "rationaleHash": proposal.rationale_hash,
        },
    }


def sign_proposal(
    proposal: Proposal,
    account: LocalAccount,
    chain_id: int,
    verifying_contract: str,
) -> str:
    typed = proposal_typed_data(proposal, chain_id, verifying_contract)
    message = encode_typed_data(full_message=typed)
    signed = account.sign_message(message)
    return signed.signature.hex()
