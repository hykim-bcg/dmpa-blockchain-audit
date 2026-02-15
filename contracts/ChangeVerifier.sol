// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./SaMDRegistry.sol";
import "./AuditTrail.sol";

/**
 * @title ChangeVerifier
 * @notice Implements Algorithm 1 — DMPA Article 11 Proviso Exemption
 *         Verification — with borderline detection, cross-contract
 *         record creation and automatic model-hash update.
 * @dev    Core contract of the AI-SaMD change-management audit trail.
 *
 *         Verification stages (cf. Algorithm 1 in the paper):
 *           Stage 1  changeType ∈ {8,9}       → NotApplicable
 *           Stage 2  changeType ∈ {4,5,6,7}   → PendingApproval
 *           Stage 3  req1 (aiEnabled) + req2 (Approved plan)
 *           Stage 4  typeOK ∧ perfOK ∧ dataOK → Exempt / Borderline / NonExempt
 */
contract ChangeVerifier {
    // ──────────────────────────── Enums ────────────────────────────
    enum VerificationResult {
        NotApplicable,    // 0
        Exempt,           // 1
        NonExempt,        // 2
        Borderline,       // 3
        PendingApproval   // 4
    }

    // ──────────────────────────── External refs ───────────────────
    SaMDRegistry public registry;
    AuditTrail   public auditTrail;

    address public admin;

    // Nonce per product for generating unique record IDs
    mapping(bytes32 => uint256) private nonces;

    // ──────────────────────────── Events ───────────────────────────
    event ChangeVerified(
        bytes32 indexed productId,
        bytes32 indexed recordId,
        VerificationResult result
    );

    // ──────────────────────────── Constructor ─────────────────────
    constructor(address _registry, address _auditTrail) {
        admin      = msg.sender;
        registry   = SaMDRegistry(_registry);
        auditTrail = AuditTrail(_auditTrail);
    }

    // ──────────────────────────── Core ─────────────────────────────
    /**
     * @notice Algorithm 1: Verify a change and record the result.
     * @param productId         Product identifier
     * @param changeType        Change type code (1-9, Table 4)
     * @param auc               AUC ×10 000
     * @param sensitivity       Sensitivity ×10 000
     * @param specificity       Specificity ×10 000
     * @param dataChangeRate    Data change rate ×100
     * @param previousModelHash Hash of the previous model
     * @param newModelHash      Hash of the new model
     * @param ipfsHash          IPFS CID hash of off-chain evidence
     * @return result            VerificationResult enum
     * @return recordId          Unique record ID stored in AuditTrail
     */
    function verifyChange(
        bytes32 productId,
        uint8   changeType,
        uint16  auc,
        uint16  sensitivity,
        uint16  specificity,
        uint16  dataChangeRate,
        bytes32 previousModelHash,
        bytes32 newModelHash,
        bytes32 ipfsHash
    )
        external
        returns (VerificationResult result, bytes32 recordId)
    {
        require(changeType >= 1 && changeType <= 9, "ChangeVerifier: invalid changeType");

        // Fetch product from registry
        SaMDRegistry.Product memory product = registry.getProduct(productId);

        // ── Stage 1: Minor change (code 8-9) ──────────────────────
        if (changeType == 8 || changeType == 9) {
            result = VerificationResult.NotApplicable;
            recordId = _recordAndReturn(
                productId, changeType, auc, sensitivity, specificity,
                dataChangeRate, previousModelHash, newModelHash,
                ipfsHash, false, result
            );
            return (result, recordId);
        }

        // ── Stage 2: Major change (code 4-7) ─────────────────────
        if (changeType >= 4 && changeType <= 7) {
            result = VerificationResult.PendingApproval;
            recordId = _recordAndReturn(
                productId, changeType, auc, sensitivity, specificity,
                dataChangeRate, previousModelHash, newModelHash,
                ipfsHash, false, result
            );
            return (result, recordId);
        }

        // ── Stage 3: Exemption prerequisites (changeType 1-3) ────
        // req1: AI-enabled product
        if (!product.aiEnabled) {
            result = VerificationResult.NonExempt;
            recordId = _recordAndReturn(
                productId, changeType, auc, sensitivity, specificity,
                dataChangeRate, previousModelHash, newModelHash,
                ipfsHash, false, result
            );
            return (result, recordId);
        }

        // req2: Approved change plan exists
        SaMDRegistry.ChangePlan memory plan;
        bool hasPlan = _tryGetPlan(productId, plan);
        if (!hasPlan || plan.status != SaMDRegistry.PlanStatus.Approved) {
            result = VerificationResult.NonExempt;
            recordId = _recordAndReturn(
                productId, changeType, auc, sensitivity, specificity,
                dataChangeRate, previousModelHash, newModelHash,
                ipfsHash, false, result
            );
            return (result, recordId);
        }

        // ── Stage 4: Scope verification ──────────────────────────
        bool typeOK = _isAllowedType(changeType, plan.allowedChangeTypes);
        bool perfOK = (auc >= plan.minAUC)
                    && (sensitivity >= plan.minSensitivity)
                    && (specificity >= plan.minSpecificity);
        bool dataOK = (dataChangeRate <= plan.maxDataChangeRate);

        if (typeOK && perfOK && dataOK) {
            // Exempt — update model hash
            result = VerificationResult.Exempt;
            registry.updateModelHash(productId, newModelHash);
            recordId = _recordAndReturn(
                productId, changeType, auc, sensitivity, specificity,
                dataChangeRate, previousModelHash, newModelHash,
                ipfsHash, true, result
            );
            return (result, recordId);
        }

        // Performance degradation takes priority (patient safety first)
        if (!perfOK) {
            result = VerificationResult.NonExempt;
            if (auc < plan.minAUC) {
                auditTrail.emitPerformanceDegradation(productId, auc, plan.minAUC);
            }
            recordId = _recordAndReturn(
                productId, changeType, auc, sensitivity, specificity,
                dataChangeRate, previousModelHash, newModelHash,
                ipfsHash, false, result
            );
            return (result, recordId);
        }

        // Borderline: performance OK but data rate marginally exceeded
        if (!dataOK && _isBorderlineDataRate(dataChangeRate, plan.maxDataChangeRate)) {
            result = VerificationResult.Borderline;
            recordId = _recordAndReturn(
                productId, changeType, auc, sensitivity, specificity,
                dataChangeRate, previousModelHash, newModelHash,
                ipfsHash, false, result
            );
            return (result, recordId);
        }

        // NonExempt (type not allowed or data rate clearly exceeded)
        result = VerificationResult.NonExempt;
        recordId = _recordAndReturn(
            productId, changeType, auc, sensitivity, specificity,
            dataChangeRate, previousModelHash, newModelHash,
            ipfsHash, false, result
        );
        return (result, recordId);
    }

    // ──────────────────────────── Internal helpers ────────────────

    /**
     * @dev Record the change in AuditTrail and emit ChangeVerified.
     */
    function _recordAndReturn(
        bytes32 productId,
        uint8   changeType,
        uint16  auc,
        uint16  sensitivity,
        uint16  specificity,
        uint16  dataChangeRate,
        bytes32 previousModelHash,
        bytes32 newModelHash,
        bytes32 ipfsHash,
        bool    withinPlanScope,
        VerificationResult result
    ) internal returns (bytes32 recordId) {
        nonces[productId]++;
        recordId = keccak256(
            abi.encodePacked(productId, nonces[productId], block.timestamp)
        );

        auditTrail.recordChange(
            recordId,
            productId,
            changeType,
            previousModelHash,
            newModelHash,
            dataChangeRate,
            auc,
            sensitivity,
            specificity,
            withinPlanScope,
            AuditTrail.VerificationResult(uint8(result)),
            ipfsHash,
            msg.sender
        );

        emit ChangeVerified(productId, recordId, result);
        return recordId;
    }

    /**
     * @dev Check whether changeType is in the plan's allowedChangeTypes.
     */
    function _isAllowedType(uint8 changeType, uint8[] memory allowed)
        internal pure returns (bool)
    {
        for (uint256 i = 0; i < allowed.length; i++) {
            if (allowed[i] == changeType) return true;
        }
        return false;
    }

    /**
     * @dev Borderline detection for data-change rate (paper III.4):
     *      Data rate exceeds max but within 110 % of max (marginal excess).
     *      Performance degradation is handled separately as NonExempt
     *      to prioritise patient safety (conservative judgement principle).
     */
    function _isBorderlineDataRate(
        uint16 dataChangeRate,
        uint16 maxDataChangeRate
    ) internal pure returns (bool) {
        return uint256(dataChangeRate) <= (uint256(maxDataChangeRate) * 110) / 100;
    }

    /**
     * @dev Try to fetch the plan for a product. Returns false if none.
     */
    function _tryGetPlan(
        bytes32 productId,
        SaMDRegistry.ChangePlan memory plan
    ) internal view returns (bool) {
        try registry.getPlanForProduct(productId) returns (
            SaMDRegistry.ChangePlan memory p
        ) {
            // Copy fields (memory → memory)
            plan.planId            = p.planId;
            plan.productId         = p.productId;
            plan.minAUC            = p.minAUC;
            plan.minSensitivity    = p.minSensitivity;
            plan.minSpecificity    = p.minSpecificity;
            plan.maxDataChangeRate = p.maxDataChangeRate;
            plan.allowedChangeTypes = p.allowedChangeTypes;
            plan.status            = p.status;
            plan.exists            = p.exists;
            return true;
        } catch {
            return false;
        }
    }
}
