// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title AuditTrail
 * @notice Immutable change-record storage, history query, integrity
 *         verification, and meta-audit logging for AI-SaMD lifecycle.
 * @dev    Implements the AuditTrail contract described in III.4 and the
 *         MFDS audit query scenario (IV.2-d) of the paper.
 */
contract AuditTrail {
    // ──────────────────────────── Enums ────────────────────────────
    /**
     * @dev Mirror of ChangeVerifier.VerificationResult so that the
     *      AuditTrail can store the result without importing the
     *      ChangeVerifier contract.
     */
    enum VerificationResult {
        NotApplicable,    // 0 – Minor change (code 8-9)
        Exempt,           // 1 – Exemption approved (§11 proviso)
        NonExempt,        // 2 – Approval required
        Borderline,       // 3 – Manual review recommended
        PendingApproval   // 4 – Major change (code 4-7)
    }

    // ──────────────────────────── Structs ──────────────────────────
    /// @dev Table 3 – ChangeRecord entity
    struct ChangeRecord {
        bytes32            recordId;
        bytes32            productId;
        uint8              changeType;
        bytes32            previousModelHash;
        bytes32            newModelHash;
        uint16             dataChangeRate;     // ×100
        uint16             auc;                // ×10 000
        uint16             sensitivity;        // ×10 000
        uint16             specificity;        // ×10 000
        bool               withinPlanScope;
        VerificationResult result;
        bytes32            ipfsHash;
        uint256            timestamp;
        address            submitter;
    }

    // ──────────────────────────── State ────────────────────────────
    address public admin;
    address public changeVerifier;

    /// recordId → ChangeRecord
    mapping(bytes32 => ChangeRecord)  private records;
    /// productId → recordId[]
    mapping(bytes32 => bytes32[])     private productHistory;
    /// recordId existence check
    mapping(bytes32 => bool)          private recordExists;

    // ──────────────────────────── Events ───────────────────────────
    event ChangeRecorded(
        bytes32 indexed productId,
        bytes32 indexed recordId,
        VerificationResult result
    );
    event PerformanceDegradation(
        bytes32 indexed productId,
        uint16  auc,
        uint16  threshold
    );
    event AuditAccessed(
        bytes32 indexed productId,
        address indexed auditor,
        uint256 timestamp
    );

    // ──────────────────────────── Modifiers ────────────────────────
    modifier onlyAdmin() {
        require(msg.sender == admin, "AuditTrail: caller is not admin");
        _;
    }

    modifier onlyChangeVerifier() {
        require(
            msg.sender == changeVerifier,
            "AuditTrail: caller is not ChangeVerifier"
        );
        _;
    }

    // ──────────────────────────── Constructor ─────────────────────
    constructor() {
        admin = msg.sender;
    }

    function setChangeVerifier(address _verifier) external onlyAdmin {
        changeVerifier = _verifier;
    }

    // ──────────────────────────── Record ──────────────────────────
    /**
     * @notice Store an immutable change record. Only callable by ChangeVerifier.
     */
    function recordChange(
        bytes32            recordId,
        bytes32            productId,
        uint8              changeType,
        bytes32            previousModelHash,
        bytes32            newModelHash,
        uint16             dataChangeRate,
        uint16             auc,
        uint16             sensitivity,
        uint16             specificity,
        bool               withinPlanScope,
        VerificationResult result,
        bytes32            ipfsHash,
        address            submitter
    ) external onlyChangeVerifier {
        require(!recordExists[recordId], "AuditTrail: record already exists");

        records[recordId] = ChangeRecord({
            recordId:          recordId,
            productId:         productId,
            changeType:        changeType,
            previousModelHash: previousModelHash,
            newModelHash:      newModelHash,
            dataChangeRate:    dataChangeRate,
            auc:               auc,
            sensitivity:       sensitivity,
            specificity:       specificity,
            withinPlanScope:   withinPlanScope,
            result:            result,
            ipfsHash:          ipfsHash,
            timestamp:         block.timestamp,
            submitter:         submitter
        });
        recordExists[recordId] = true;
        productHistory[productId].push(recordId);

        emit ChangeRecorded(productId, recordId, result);
    }

    /**
     * @notice Emit a PerformanceDegradation event. Called by ChangeVerifier
     *         when AUC falls below the plan threshold.
     */
    function emitPerformanceDegradation(
        bytes32 productId,
        uint16  auc,
        uint16  threshold
    ) external onlyChangeVerifier {
        emit PerformanceDegradation(productId, auc, threshold);
    }

    // ──────────────────────────── Query ───────────────────────────
    /**
     * @notice Return the full change history for a product.
     */
    function getChangeHistory(bytes32 productId)
        external view returns (ChangeRecord[] memory)
    {
        bytes32[] storage ids = productHistory[productId];
        ChangeRecord[] memory result = new ChangeRecord[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            result[i] = records[ids[i]];
        }
        return result;
    }

    /**
     * @notice Return change records within a time window.
     */
    function getChangesByPeriod(
        bytes32 productId,
        uint256 fromTime,
        uint256 toTime
    ) external view returns (ChangeRecord[] memory) {
        bytes32[] storage ids = productHistory[productId];

        // First pass: count matches
        uint256 count = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 ts = records[ids[i]].timestamp;
            if (ts >= fromTime && ts <= toTime) {
                count++;
            }
        }

        // Second pass: collect
        ChangeRecord[] memory filtered = new ChangeRecord[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 ts = records[ids[i]].timestamp;
            if (ts >= fromTime && ts <= toTime) {
                filtered[idx] = records[ids[i]];
                idx++;
            }
        }
        return filtered;
    }

    /**
     * @notice Return a single record by its ID.
     */
    function getRecord(bytes32 recordId)
        external view returns (ChangeRecord memory)
    {
        require(recordExists[recordId], "AuditTrail: record not found");
        return records[recordId];
    }

    /**
     * @notice Return the number of change records for a product.
     */
    function getHistoryLength(bytes32 productId)
        external view returns (uint256)
    {
        return productHistory[productId].length;
    }

    // ──────────────────────────── Integrity ───────────────────────
    /**
     * @notice Verify that an off-chain hash matches the on-chain record.
     */
    function verifyIntegrity(bytes32 recordId, bytes32 offchainHash)
        external view returns (bool)
    {
        require(recordExists[recordId], "AuditTrail: record not found");
        return records[recordId].ipfsHash == offchainHash;
    }

    // ──────────────────────────── Meta-audit ──────────────────────
    /**
     * @notice Log an audit access event (the query itself is recorded
     *         on-chain for meta-audit traceability).
     */
    function logAuditAccess(bytes32 productId, string calldata action)
        external
    {
        emit AuditAccessed(productId, msg.sender, block.timestamp);
    }
}
