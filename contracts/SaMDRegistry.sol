// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title SaMDRegistry
 * @notice Product registration, Change Management Plan submission/approval,
 *         and role-based access control for AI-SaMD lifecycle governance.
 * @dev    Implements DMPA Article 8 (Change Management Plan submission)
 *         and role-based access per Table 5 of the paper.
 *
 *         Performance metrics are stored as uint16 scaled ×10 000
 *         (e.g. AUC 0.9000 → 9000).  Data-change rate is scaled ×100
 *         (e.g. 20 % → 2000).
 */
contract SaMDRegistry {
    // ──────────────────────────── Enums ────────────────────────────
    enum PlanStatus { Submitted, Approved, Revoked }
    enum Role       { None, Manufacturer, MFDS, Certifier }

    // ──────────────────────────── Structs ──────────────────────────
    /// @dev Table 3 – Product entity
    struct Product {
        bytes32 productId;
        address manufacturer;
        uint8   deviceClass;       // 1–4
        uint8   safetyClass;       // 0 = A, 1 = B, 2 = C
        bool    aiEnabled;
        bytes32 currentModelHash;
        bool    exists;
    }

    /// @dev Table 3 – ChangePlan entity
    struct ChangePlan {
        bytes32      planId;
        bytes32      productId;
        uint16       minAUC;              // ×10 000
        uint16       minSensitivity;      // ×10 000
        uint16       minSpecificity;      // ×10 000
        uint16       maxDataChangeRate;   // ×100
        uint8[]      allowedChangeTypes;  // e.g. [1,2,3]
        PlanStatus   status;
        bool         exists;
    }

    // ──────────────────────────── State ────────────────────────────
    address public admin;

    mapping(bytes32 => Product)    private products;
    mapping(bytes32 => ChangePlan) private plans;
    mapping(bytes32 => bytes32)    private productToPlan;   // productId → planId
    mapping(address => Role)       public  roles;

    // Authorised ChangeVerifier address
    address public changeVerifier;

    // ──────────────────────────── Events ───────────────────────────
    event ProductRegistered(bytes32 indexed productId, address indexed manufacturer);
    event ChangePlanSubmitted(bytes32 indexed planId, bytes32 indexed productId);
    event ChangePlanApproved(bytes32 indexed planId);
    event ChangePlanRevoked(bytes32 indexed planId);
    event RoleGranted(address indexed account, Role role);
    event ModelHashUpdated(bytes32 indexed productId, bytes32 newHash);

    // ──────────────────────────── Modifiers ────────────────────────
    modifier onlyAdmin() {
        require(msg.sender == admin, "SaMDRegistry: caller is not admin");
        _;
    }

    modifier onlyMFDS() {
        require(roles[msg.sender] == Role.MFDS, "SaMDRegistry: caller is not MFDS");
        _;
    }

    modifier onlyManufacturer(bytes32 productId) {
        require(products[productId].exists, "SaMDRegistry: product not found");
        require(
            products[productId].manufacturer == msg.sender,
            "SaMDRegistry: caller is not product manufacturer"
        );
        _;
    }

    modifier onlyChangeVerifier() {
        require(msg.sender == changeVerifier, "SaMDRegistry: caller is not ChangeVerifier");
        _;
    }

    // ──────────────────────────── Constructor ─────────────────────
    constructor() {
        admin = msg.sender;
    }

    // ──────────────────────────── Admin ────────────────────────────
    function grantRole(address account, Role role) external onlyAdmin {
        roles[account] = role;
        emit RoleGranted(account, role);
    }

    function setChangeVerifier(address _verifier) external onlyAdmin {
        changeVerifier = _verifier;
    }

    // ──────────────────────────── Product ──────────────────────────
    /**
     * @notice Register a new AI-SaMD product.
     */
    function registerProduct(
        bytes32 productId,
        uint8   deviceClass,
        uint8   safetyClass,
        bool    aiEnabled,
        bytes32 modelHash
    ) external {
        require(
            roles[msg.sender] == Role.Manufacturer,
            "SaMDRegistry: caller is not a Manufacturer"
        );
        require(!products[productId].exists, "SaMDRegistry: product already exists");
        require(deviceClass >= 1 && deviceClass <= 4, "SaMDRegistry: invalid deviceClass");
        require(safetyClass <= 2, "SaMDRegistry: invalid safetyClass");

        products[productId] = Product({
            productId:        productId,
            manufacturer:     msg.sender,
            deviceClass:      deviceClass,
            safetyClass:      safetyClass,
            aiEnabled:        aiEnabled,
            currentModelHash: modelHash,
            exists:           true
        });

        emit ProductRegistered(productId, msg.sender);
    }

    function getProduct(bytes32 productId)
        external view returns (Product memory)
    {
        require(products[productId].exists, "SaMDRegistry: product not found");
        return products[productId];
    }

    // ──────────────────────────── Change Plan ─────────────────────
    /**
     * @notice Submit a Change Management Plan (DMPA Article 8).
     */
    function submitChangePlan(
        bytes32  planId,
        bytes32  productId,
        uint16   minAUC,
        uint16   minSensitivity,
        uint16   minSpecificity,
        uint16   maxDataChangeRate,
        uint8[] calldata allowedChangeTypes
    ) external onlyManufacturer(productId) {
        require(!plans[planId].exists, "SaMDRegistry: plan already exists");
        require(allowedChangeTypes.length > 0, "SaMDRegistry: empty allowedChangeTypes");

        plans[planId] = ChangePlan({
            planId:            planId,
            productId:         productId,
            minAUC:            minAUC,
            minSensitivity:    minSensitivity,
            minSpecificity:    minSpecificity,
            maxDataChangeRate: maxDataChangeRate,
            allowedChangeTypes: allowedChangeTypes,
            status:            PlanStatus.Submitted,
            exists:            true
        });
        productToPlan[productId] = planId;

        emit ChangePlanSubmitted(planId, productId);
    }

    /**
     * @notice Approve a submitted Change Management Plan (MFDS only).
     */
    function approvePlan(bytes32 planId) external onlyMFDS {
        require(plans[planId].exists, "SaMDRegistry: plan not found");
        require(
            plans[planId].status == PlanStatus.Submitted,
            "SaMDRegistry: plan not in Submitted status"
        );
        plans[planId].status = PlanStatus.Approved;
        emit ChangePlanApproved(planId);
    }

    /**
     * @notice Revoke an approved plan.
     */
    function revokePlan(bytes32 planId) external onlyMFDS {
        require(plans[planId].exists, "SaMDRegistry: plan not found");
        plans[planId].status = PlanStatus.Revoked;
        emit ChangePlanRevoked(planId);
    }

    function getPlan(bytes32 planId)
        external view returns (ChangePlan memory)
    {
        require(plans[planId].exists, "SaMDRegistry: plan not found");
        return plans[planId];
    }

    function getPlanForProduct(bytes32 productId)
        external view returns (ChangePlan memory)
    {
        bytes32 planId = productToPlan[productId];
        require(plans[planId].exists, "SaMDRegistry: no plan for product");
        return plans[planId];
    }

    // ──────────────────────────── Internal (cross-contract) ───────
    /**
     * @notice Update the current model hash after an exempt change.
     * @dev    Called only by ChangeVerifier.
     */
    function updateModelHash(bytes32 productId, bytes32 newHash)
        external onlyChangeVerifier
    {
        require(products[productId].exists, "SaMDRegistry: product not found");
        products[productId].currentModelHash = newHash;
        emit ModelHashUpdated(productId, newHash);
    }
}
