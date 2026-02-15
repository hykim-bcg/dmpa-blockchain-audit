const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * 5-Scenario Validation (Paper Section IV.2)
 *
 * Product: DR diagnostic AI-SaMD
 *   - deviceClass = 2, safetyClass = B (1), aiEnabled = true
 *
 * Change Management Plan:
 *   - minAUC = 9000 (0.90), minSensitivity = 8500 (0.85),
 *     minSpecificity = 8500 (0.85)
 *   - maxDataChangeRate = 2000 (20 %)
 *   - allowedChangeTypes = [1, 2, 3]
 *
 * VerificationResult enum:
 *   0 = NotApplicable, 1 = Exempt, 2 = NonExempt,
 *   3 = Borderline, 4 = PendingApproval
 */
describe("AI-SaMD Audit Trail — 5 Scenario Validation", function () {
  let registry, verifier, auditTrail;
  let admin, manufacturer, mfds, auditor;

  const PRODUCT_ID = ethers.id("DR-AI-SaMD-001");
  const PLAN_ID    = ethers.id("CMP-001");
  const MODEL_HASH_V1 = ethers.id("model-v1.0");
  const MODEL_HASH_V2 = ethers.id("model-v2.0");
  const MODEL_HASH_V3 = ethers.id("model-v3-vit");
  const MODEL_HASH_V4 = ethers.id("model-v4-degraded");
  const MODEL_HASH_V5 = ethers.id("model-v5-bigdata");
  const IPFS_HASH_1   = ethers.id("ipfs-evidence-1");
  const IPFS_HASH_2   = ethers.id("ipfs-evidence-2");
  const IPFS_HASH_3   = ethers.id("ipfs-evidence-3");
  const IPFS_HASH_5   = ethers.id("ipfs-evidence-5");

  // Stored record IDs for scenario 4
  let recordId1, recordId2, recordId3;

  before(async function () {
    [admin, manufacturer, mfds, auditor] = await ethers.getSigners();

    // Deploy contracts
    const SaMDRegistry = await ethers.getContractFactory("SaMDRegistry");
    registry = await SaMDRegistry.deploy();
    await registry.waitForDeployment();

    const AuditTrail = await ethers.getContractFactory("AuditTrail");
    auditTrail = await AuditTrail.deploy();
    await auditTrail.waitForDeployment();

    const ChangeVerifier = await ethers.getContractFactory("ChangeVerifier");
    verifier = await ChangeVerifier.deploy(
      await registry.getAddress(),
      await auditTrail.getAddress()
    );
    await verifier.waitForDeployment();

    // Wire cross-contract references
    await registry.setChangeVerifier(await verifier.getAddress());
    await auditTrail.setChangeVerifier(await verifier.getAddress());

    // Grant roles
    await registry.grantRole(manufacturer.address, 1); // Manufacturer
    await registry.grantRole(mfds.address, 2);          // MFDS

    // Register product (manufacturer)
    await registry.connect(manufacturer).registerProduct(
      PRODUCT_ID,
      2,               // deviceClass 2
      1,               // safetyClass B
      true,            // aiEnabled
      MODEL_HASH_V1
    );

    // Submit change plan (manufacturer)
    await registry.connect(manufacturer).submitChangePlan(
      PLAN_ID,
      PRODUCT_ID,
      9000,            // minAUC (0.90)
      8500,            // minSensitivity (0.85)
      8500,            // minSpecificity (0.85)
      2000,            // maxDataChangeRate (20%)
      [1, 2, 3]        // allowedChangeTypes
    );

    // Approve plan (MFDS)
    await registry.connect(mfds).approvePlan(PLAN_ID);
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 1: Model retraining — within plan scope → Exempt
  // ────────────────────────────────────────────────────────────────
  describe("Scenario 1: Model Retraining — Within Plan Scope", function () {
    it("should return Exempt (1) for in-scope retraining", async function () {
      const tx = await verifier.connect(manufacturer).verifyChange(
        PRODUCT_ID,
        1,               // changeType = 1 (Model Retraining)
        9520,            // AUC 0.952
        9210,            // Sensitivity 0.921
        9430,            // Specificity 0.943
        1000,            // dataChangeRate 10%
        MODEL_HASH_V1,
        MODEL_HASH_V2,
        IPFS_HASH_1
      );

      const receipt = await tx.wait();

      // Find ChangeVerified event
      const event = receipt.logs.find(
        (log) => {
          try {
            return verifier.interface.parseLog(log)?.name === "ChangeVerified";
          } catch { return false; }
        }
      );
      const parsed = verifier.interface.parseLog(event);
      recordId1 = parsed.args.recordId;

      // VerificationResult = 1 (Exempt)
      expect(parsed.args.result).to.equal(1n);

      // Model hash should be updated in registry
      const product = await registry.getProduct(PRODUCT_ID);
      expect(product.currentModelHash).to.equal(MODEL_HASH_V2);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 2: Algorithm change → PendingApproval
  // ────────────────────────────────────────────────────────────────
  describe("Scenario 2: Algorithm Architecture Change — Approval Required", function () {
    it("should return PendingApproval (4) regardless of performance", async function () {
      const tx = await verifier.connect(manufacturer).verifyChange(
        PRODUCT_ID,
        4,               // changeType = 4 (Algorithm Architecture Change)
        9680,            // AUC 0.968 (excellent, but irrelevant)
        9500,            // Sensitivity
        9600,            // Specificity
        500,             // dataChangeRate 5%
        MODEL_HASH_V2,
        MODEL_HASH_V3,
        IPFS_HASH_2
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => {
          try {
            return verifier.interface.parseLog(log)?.name === "ChangeVerified";
          } catch { return false; }
        }
      );
      const parsed = verifier.interface.parseLog(event);
      recordId2 = parsed.args.recordId;

      // VerificationResult = 4 (PendingApproval)
      expect(parsed.args.result).to.equal(4n);

      // Model hash should NOT be updated (not exempt)
      const product = await registry.getProduct(PRODUCT_ID);
      expect(product.currentModelHash).to.equal(MODEL_HASH_V2);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 3: Performance degradation detected
  // ────────────────────────────────────────────────────────────────
  describe("Scenario 3: Performance Degradation Detection", function () {
    it("should return NonExempt (2) and emit PerformanceDegradation", async function () {
      const tx = await verifier.connect(manufacturer).verifyChange(
        PRODUCT_ID,
        1,               // changeType = 1 (Model Retraining)
        8720,            // AUC 0.872 — BELOW minAUC 0.90
        9100,            // Sensitivity (OK)
        9200,            // Specificity (OK)
        800,             // dataChangeRate 8% (OK)
        MODEL_HASH_V2,
        MODEL_HASH_V4,
        IPFS_HASH_3
      );

      const receipt = await tx.wait();

      // Find ChangeVerified event
      const verifiedEvent = receipt.logs.find(
        (log) => {
          try {
            return verifier.interface.parseLog(log)?.name === "ChangeVerified";
          } catch { return false; }
        }
      );
      const parsed = verifier.interface.parseLog(verifiedEvent);
      recordId3 = parsed.args.recordId;

      // VerificationResult = 2 (NonExempt)
      expect(parsed.args.result).to.equal(2n);

      // PerformanceDegradation event should be emitted from AuditTrail
      const degradationEvent = receipt.logs.find(
        (log) => {
          try {
            return auditTrail.interface.parseLog(log)?.name === "PerformanceDegradation";
          } catch { return false; }
        }
      );
      expect(degradationEvent).to.not.be.undefined;
      const degradationParsed = auditTrail.interface.parseLog(degradationEvent);
      expect(degradationParsed.args.auc).to.equal(8720n);
      expect(degradationParsed.args.threshold).to.equal(9000n);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 4: MFDS Audit — history query + integrity verification
  // ────────────────────────────────────────────────────────────────
  describe("Scenario 4: MFDS Regulatory Audit", function () {
    it("should return 3 change records in history", async function () {
      const history = await auditTrail.getChangeHistory(PRODUCT_ID);
      expect(history.length).to.equal(3);
    });

    it("should verify on-chain/off-chain hash integrity", async function () {
      // Record 1: IPFS_HASH_1
      const ok1 = await auditTrail.verifyIntegrity(recordId1, IPFS_HASH_1);
      expect(ok1).to.be.true;

      // Wrong hash should fail
      const bad = await auditTrail.verifyIntegrity(recordId1, IPFS_HASH_2);
      expect(bad).to.be.false;
    });

    it("should emit AuditAccessed event on audit log", async function () {
      const tx = await auditTrail
        .connect(mfds)
        .logAuditAccess(PRODUCT_ID, "12-month regulatory audit");

      await expect(tx)
        .to.emit(auditTrail, "AuditAccessed")
        .withArgs(PRODUCT_ID, mfds.address, await getBlockTimestamp(tx));
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 5: Large data addition — data change rate exceeded
  // ────────────────────────────────────────────────────────────────
  describe("Scenario 5: Large Data Addition — Data Change Rate Exceeded", function () {
    it("should return NonExempt (2) when data change rate exceeds plan limit", async function () {
      const tx = await verifier.connect(manufacturer).verifyChange(
        PRODUCT_ID,
        2,               // changeType = 2 (Training Data Update)
        9610,            // AUC 0.961 (OK)
        9300,            // Sensitivity (OK)
        9400,            // Specificity (OK)
        3000,            // dataChangeRate 30% — EXCEEDS maxDataChangeRate 20%
        MODEL_HASH_V2,
        MODEL_HASH_V5,
        IPFS_HASH_5
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => {
          try {
            return verifier.interface.parseLog(log)?.name === "ChangeVerified";
          } catch { return false; }
        }
      );
      const parsed = verifier.interface.parseLog(event);

      // VerificationResult = 2 (NonExempt)
      expect(parsed.args.result).to.equal(2n);

      // Model hash should NOT be updated
      const product = await registry.getProduct(PRODUCT_ID);
      expect(product.currentModelHash).to.equal(MODEL_HASH_V2);
    });
  });
});

// ──────────────────────── Helper ──────────────────────────────────
async function getBlockTimestamp(tx) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  return block.timestamp;
}
