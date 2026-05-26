"""Hand-rolled minimal ABIs for the contracts the agents touch.

Kept small and explicit so we don't have to ship the full forge artifacts
with the Python package. If a function isn't here, it doesn't need to be
called by an agent.
"""
from __future__ import annotations

PROPOSAL_TUPLE = {
    "components": [
        {"name": "epoch", "type": "uint256"},
        {
            "name": "allocation",
            "type": "tuple",
            "components": [
                {"name": "tokens", "type": "address[]"},
                {"name": "weightsBps", "type": "uint16[]"},
            ],
        },
        {"name": "rationaleHash", "type": "bytes32"},
        {"name": "signature", "type": "bytes"},
    ],
    "name": "proposal",
    "type": "tuple",
}

ALLOCATION_TUPLE = {
    "components": [
        {"name": "tokens", "type": "address[]"},
        {"name": "weightsBps", "type": "uint16[]"},
    ],
    "name": "",
    "type": "tuple",
}


AGENT_REGISTRY_ABI = [
    {
        "type": "function",
        "name": "register",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "bondAmount", "type": "uint256"},
            {"name": "specialty", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "isActive",
        "stateMutability": "view",
        "inputs": [{"name": "agent", "type": "address"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "minBond",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "bondToken",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "agents",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [
            {"name": "specialty", "type": "bytes32"},
            {"name": "bond", "type": "uint256"},
            {"name": "reputation", "type": "uint256"},
            {"name": "strikes", "type": "uint256"},
            {"name": "active", "type": "bool"},
        ],
    },
]


PROPOSAL_ROUND_ABI = [
    {
        "type": "function",
        "name": "currentEpoch",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "currentPhase",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "type": "function",
        "name": "epochs",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [
            {"name": "commitOpen", "type": "uint64"},
            {"name": "commitClose", "type": "uint64"},
            {"name": "revealClose", "type": "uint64"},
            {"name": "phase", "type": "uint8"},
        ],
    },
    {
        "type": "function",
        "name": "commit",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "commitHash", "type": "bytes32"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "reveal",
        "stateMutability": "nonpayable",
        "inputs": [PROPOSAL_TUPLE],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "hashProposal",
        "stateMutability": "pure",
        "inputs": [
            {"name": "epoch", "type": "uint256"},
            {"name": "agent", "type": "address"},
            PROPOSAL_TUPLE,
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "commits",
        "stateMutability": "view",
        "inputs": [
            {"name": "", "type": "uint256"},
            {"name": "", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
]


CONSENSUS_ABI = [
    {
        "type": "function",
        "name": "resolved",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "getWinningAllocation",
        "stateMutability": "view",
        "inputs": [{"name": "epoch", "type": "uint256"}],
        "outputs": [ALLOCATION_TUPLE],
    },
    {
        "type": "function",
        "name": "getWinningMembers",
        "stateMutability": "view",
        "inputs": [{"name": "epoch", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address[]"}],
    },
]


PERFORMANCE_FEE_ABI = [
    {
        "type": "function",
        "name": "claim",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "epoch", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "pendingFor",
        "stateMutability": "view",
        "inputs": [
            {"name": "epoch", "type": "uint256"},
            {"name": "agent", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]


MOCK_USDC_ABI = [
    {
        "type": "function",
        "name": "mint",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "approve",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "balanceOf",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "allowance",
        "stateMutability": "view",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]


# Phase enum (ProposalRound.Phase) — index matches Solidity definition.
PHASE_IDLE = 0
PHASE_COMMIT = 1
PHASE_REVEAL = 2
PHASE_CLOSED = 3
PHASE_NAMES = {0: "Idle", 1: "Commit", 2: "Reveal", 3: "Closed"}
