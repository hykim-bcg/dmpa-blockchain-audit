const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * PhD Thesis Extension Tests (beyond the 5-scenario JBER validation)
 *
 * S6  Borderline path (Algorithm 1, Stage 4):
 *     data change rate exceeds maxDataChangeRate but stays within 110 % of it
 *     while performance criteria pass  ->  VerificationResult.Borderline (3)
 *     - boundary inclusive check at exactly 110 %
 *     - just-beyond check (> 110 %)   ->  NonExempt (2)
 *
 * S4-bench  Regulatory-audit benchmark:
 *     seeds 23 change records (mixed verdicts, simulating 12 months of
 *     operation), queries the full history, verifies on-chain/off-chain
 *     hash integrity for all 23 records, and reports local query time.
 *
 * VerificationResult enum:
 *   0 NotApplicable, 1 Exempt, 2 NonExempt, 3 Borderline, 4 PendingApproval
 */
describe("Thesis Extension — Borderline Path & Audit Benchmark", function () {
  let registry, verifier, auditTrail;
  let admin, manufacturer, mfds;

  const PRODUCT_ID = ethers.id("DR-AI-SaMD-EXT-001");
  const PLAN_ID    = ethers.id("CMP-EXT-001");
  const HASH  = (s) => ethers.id(s);

  async function verify(changeType, auc, sens, spec, rate, tag) {
    const tx = await verifier.connect(manufacturer).verifyChange(
      PRODUCT_ID, changeType, auc, sens, spec, rate,
      HASH(`prev-${tag}`), HASH(`new-${tag}`), HASH(`ipfs-${tag}`)
    );
    const receipt = await tx.wait();
    const ev = receipt.logs.find((log) => {
      try { return verifier.interface.parseLog(log)?.name === "ChangeVerified"; }
      catch { return false; }
    });
    const parsed = verifier.interface.parseLog(ev);
    return { result: parsed.args.result, recordId: parsed.args.recordId,
             ipfsHash: HASH(`ipfs-${tag}`) };
  }

  before(async function () {
    [admin, manufacturer, mfds] = await ethers.getSigners();

    const SaMDRegistry = await ethers.getContractFactory("SaMDRegistry");
    registry = await SaMDRegistry.deploy();
    await registry.waitForDeployment();

    const AuditTrail = await ethers.getContractFactory("AuditTrail");
    auditTrail = await AuditTrail.deploy();
    await auditTrail.waitForDeployment();

    const ChangeVerifier = await ethers.getContractFactory("ChangeVerifier");
    verifier = await ChangeVerifier.deploy(
      await registry.getAddress(), await auditTrail.getAddress()
    );
    await verifier.waitForDeployment();

    await registry.setChangeVerifier(await verifier.getAddress());
    await auditTrail.setChangeVerifier(await verifier.getAddress());
    await registry.grantRole(manufacturer.address, 1); // Manufacturer
    await registry.grantRole(mfds.address, 2);          // MFDS

    await registry.connect(manufacturer).registerProduct(
      PRODUCT_ID, 2, 1, true, HASH("model-v1.0")
    );
    // Plan: minAUC 0.90, minSens/Spec 0.85, maxDataChangeRate 20 %, types 1-3
    await registry.connect(manufacturer).submitChangePlan(
      PLAN_ID, PRODUCT_ID, 9000, 8500, 8500, 2000, [1, 2, 3]
    );
    await registry.connect(mfds).approvePlan(PLAN_ID);
  });

  // ────────────────────────────────────────────────────────────────
  // S6: Borderline data-change-rate path
  // ────────────────────────────────────────────────────────────────
  describe("S6: Borderline — marginal data-change-rate excess", function () {
    it("returns Borderline (3) at 21% (within 110% of the 20% limit)", async function () {
      const { result } = await verify(2, 9520, 9200, 9300, 2100, "s6-21pct");
      expect(result).to.equal(3n);
      // model hash must NOT be updated on Borderline
      const product = await registry.getProduct(PRODUCT_ID);
      expect(product.currentModelHash).to.equal(HASH("model-v1.0"));
    });

    it("returns Borderline (3) at exactly 22% (boundary inclusive, = 110%)", async function () {
      const { result } = await verify(2, 9520, 9200, 9300, 2200, "s6-22pct");
      expect(result).to.equal(3n);
    });

    it("returns NonExempt (2) just beyond the borderline band (22.01%)", async function () {
      const { result } = await verify(2, 9520, 9200, 9300, 2201, "s6-2201");
      expect(result).to.equal(2n);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // S4-bench: 23-record audit-history benchmark
  // ────────────────────────────────────────────────────────────────
  describe("S4-bench: 23-record regulatory audit benchmark", function () {
    const records = [];

    it("seeds 23 change records with mixed verdicts", async function () {
      // fresh product so history length is exactly 23
      this.timeout(120000);
      const PID2 = ethers.id("DR-AI-SaMD-EXT-002");
      const PLN2 = ethers.id("CMP-EXT-002");
      await registry.connect(manufacturer).registerProduct(PID2, 2, 1, true, HASH("m2-v1"));
      await registry.connect(manufacturer).submitChangePlan(
        PLN2, PID2, 9000, 8500, 8500, 2000, [1, 2, 3]);
      await registry.connect(mfds).approvePlan(PLN2);

      const verify2 = async (t, a, s, p, r, tag) => {
        const tx = await verifier.connect(manufacturer).verifyChange(
          PID2, t, a, s, p, r, HASH(`p-${tag}`), HASH(`n-${tag}`), HASH(`i-${tag}`));
        const receipt = await tx.wait();
        const ev = receipt.logs.find((log) => {
          try { return verifier.interface.parseLog(log)?.name === "ChangeVerified"; }
          catch { return false; }
        });
        const parsed = verifier.interface.parseLog(ev);
        records.push({ recordId: parsed.args.recordId, ipfsHash: HASH(`i-${tag}`),
                       result: parsed.args.result });
      };

      // 14 Exempt (in-scope retraining / data updates / hyperparameters)
      for (let k = 0; k < 14; k++) {
        await verify2((k % 3) + 1, 9300 + k * 10, 8800, 8900, 500 + k * 50, `ex-${k}`);
      }
      // 3 PendingApproval (major changes, codes 4-6)
      for (let k = 0; k < 3; k++) await verify2(4 + k, 9600, 9400, 9500, 300, `pa-${k}`);
      // 2 NonExempt (performance below threshold / rate clearly exceeded)
      await verify2(1, 8700, 9000, 9100, 800, "ne-perf");
      await verify2(2, 9500, 9200, 9300, 3000, "ne-rate");
      // 2 Borderline (marginal rate excess)
      await verify2(2, 9450, 9100, 9200, 2100, "bd-0");
      await verify2(2, 9480, 9150, 9250, 2150, "bd-1");
      // 2 NotApplicable (minor changes, codes 8-9)
      await verify2(8, 0, 0, 0, 0, "na-0");
      await verify2(9, 0, 0, 0, 0, "na-1");

      expect(records.length).to.equal(23);
      this.pid2 = PID2;

      const t0 = performance.now();
      const history = await auditTrail.getChangeHistory(PID2);
      const t1 = performance.now();
      expect(history.length).to.equal(23);
      console.log(`      -> getChangeHistory(23 records): ${(t1 - t0).toFixed(1)} ms (local Hardhat)`);
    });

    it("verifies on-chain/off-chain hash integrity for all 23 records", async function () {
      let ok = 0;
      for (const r of records) {
        if (await auditTrail.verifyIntegrity(r.recordId, r.ipfsHash)) ok++;
      }
      expect(ok).to.equal(23);

      // tampered off-chain evidence must be detected
      const bad = await auditTrail.verifyIntegrity(records[0].recordId, HASH("tampered"));
      expect(bad).to.be.false;
      console.log(`      -> integrity verified 23/23; tampered hash rejected`);
    });
  });
});
