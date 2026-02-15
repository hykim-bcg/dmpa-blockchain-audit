# Blockchain-based AI-SaMD Change Management Audit Trail System

Smart contract implementation for the paper:

**"Design of a Blockchain-Based Audit Trail System for AI-SaMD Change Management Under Korea's Digital Medical Products Act (DMPA)"**

Hoyeong Kim, Kyuman Lee — Department of Bio Medical Devices, Graduate School, Gachon University

## Background

Korea enacted the Digital Medical Products Act (DMPA) in January 2024 (effective January 2025), the world's first standalone legislation for digital medical products. DMPA Article 8 introduces a Change Management Plan (CMP) system for AI-SaMD, and Article 11 proviso exempts modifications within the approved plan scope from additional change approval. This system implements the automated scope verification mechanism described in the paper.

## Architecture

Three Solidity smart contracts (~740 lines total):

| Contract | Lines | Role |
|----------|-------|------|
| `SaMDRegistry.sol` | 224 | Product registration, Change Management Plan submission/approval, RBAC |
| `ChangeVerifier.sol` | 281 | Algorithm 1 — DMPA Article 11 proviso exemption verification |
| `AuditTrail.sol` | 238 | Immutable change records, history query, integrity verification |

## Tech Stack

- Solidity 0.8.19
- Hardhat 2.x
- Hyperledger Besu (IBFT 2.0) — target deployment platform

## Quick Start

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Test Scenarios (Paper Section IV.2)

| # | Scenario | Expected Result | Status |
|---|----------|----------------|--------|
| 1 | Model retraining — within plan scope | Exempt | PASS |
| 2 | Algorithm architecture change | PendingApproval | PASS |
| 3 | Performance degradation detection | NonExempt + Event | PASS |
| 4 | MFDS regulatory audit query | 3 records + integrity OK | PASS |
| 5 | Large data addition — rate exceeded | NonExempt | PASS |

## Key Results

- Classification accuracy: 100% (5/5 scenarios)
- Average processing time: 2.05 seconds
- Time reduction vs manual process: ~87%

## License

MIT
