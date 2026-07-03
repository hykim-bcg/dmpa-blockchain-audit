const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Multi-Regulatory Parameterization (PhD thesis Section 4.2.7)
 *
 * Demonstrates that the SAME Algorithm 1 code base adjudicates change
 * submissions under different regulatory rule sets, expressed purely as
 * ChangePlan parameters:
 *
 *   KR-DMPA plan   : minAUC 0.90, minSens/Spec 0.85, maxRate 20 %, types {1,2,3}
 *   US-PCCP plan   : minAUC 0.93, minSens 0.90 / minSpec 0.88, maxRate 10 %, types {1,2}
 *     (illustrative PCCP Modification-Protocol acceptance criteria: tighter
 *      performance floor and data-update bound, hyperparameter tuning excluded)
 *
 * The identical change submission then receives jurisdiction-specific
 * verdicts, supporting the structural-isomorphism claim (thesis 5.4.1) and
 * the regulation-agnostic infrastructure claim (thesis 5.4.3).
 */
describe("Multi-Regulatory Parameterization — one code base, two rule sets", function () {
  let registry, verifier, auditTrail;
  let admin, manufacturer, mfds;

  const KR = ethers.id("CancerDx-AI-KR");
  const US = ethers.id("CancerDx-AI-US");
  const HASH = (s) => ethers.id(s);

  async function verify(pid, tag, c) {
    const tx = await verifier.connect(manufacturer).verifyChange(
      pid, c.type, c.auc, c.sens, c.spec, c.rate,
      HASH(`${tag}-prev`), HASH(`${tag}-new`), HASH(`${tag}-ipfs`));
    const receipt = await tx.wait();
    const ev = receipt.logs.find((log) => {
      try { return verifier.interface.parseLog(log)?.name === "ChangeVerified"; }
      catch { return false; }
    });
    return Number(verifier.interface.parseLog(ev).args.result);
  }

  before(async function () {
    [admin, manufacturer, mfds] = await ethers.getSigners();
    const R = await (await ethers.getContractFactory("SaMDRegistry")).deploy();
    await R.waitForDeployment();
    const A = await (await ethers.getContractFactory("AuditTrail")).deploy();
    await A.waitForDeployment();
    const V = await (await ethers.getContractFactory("ChangeVerifier"))
      .deploy(await R.getAddress(), await A.getAddress());
    await V.waitForDeployment();
    await R.setChangeVerifier(await V.getAddress());
    await A.setChangeVerifier(await V.getAddress());
    await R.grantRole(manufacturer.address, 1);
    await R.grantRole(mfds.address, 2);
    registry = R; auditTrail = A; verifier = V;

    // Same product marketed in two jurisdictions, one plan per jurisdiction
    await registry.connect(manufacturer).registerProduct(KR, 3, 2, true, HASH("kr-v1"));
    await registry.connect(manufacturer).registerProduct(US, 3, 2, true, HASH("us-v1"));
    await registry.connect(manufacturer).submitChangePlan(
      ethers.id("PLAN-KR-DMPA"), KR, 9000, 8500, 8500, 2000, [1, 2, 3]);
    await registry.connect(manufacturer).submitChangePlan(
      ethers.id("PLAN-US-PCCP"), US, 9300, 9000, 8800, 1000, [1, 2]);
    await registry.connect(mfds).approvePlan(ethers.id("PLAN-KR-DMPA"));
    await registry.connect(mfds).approvePlan(ethers.id("PLAN-US-PCCP"));
  });

  // C-A: retraining, strong metrics, 8 % data update -> exempt under BOTH
  it("C-A (retrain, AUC .952, rate 8%): Exempt under KR-DMPA and US-PCCP", async function () {
    const c = { type: 1, auc: 9520, sens: 9210, spec: 9430, rate: 800 };
    expect(await verify(KR, "ca-kr", c)).to.equal(1);
    expect(await verify(US, "ca-us", c)).to.equal(1);
  });

  // C-B: data update, 15 % rate -> KR exempt (<=20 %), US non-exempt (>10 %, beyond 110 %)
  it("C-B (data update, AUC .940, rate 15%): Exempt under KR, NonExempt under US", async function () {
    const c = { type: 2, auc: 9400, sens: 9100, spec: 9200, rate: 1500 };
    expect(await verify(KR, "cb-kr", c)).to.equal(1);
    expect(await verify(US, "cb-us", c)).to.equal(2);
  });

  // C-C: hyperparameter tuning -> allowed type in KR, excluded from US plan
  it("C-C (hyperparameter, AUC .945, rate 2%): Exempt under KR, NonExempt under US", async function () {
    const c = { type: 3, auc: 9450, sens: 9150, spec: 9300, rate: 200 };
    expect(await verify(KR, "cc-kr", c)).to.equal(1);
    expect(await verify(US, "cc-us", c)).to.equal(2);
  });

  // C-D: AUC .915 -> above KR floor (.90), below US floor (.93)
  it("C-D (retrain, AUC .915, rate 5%): Exempt under KR, NonExempt under US", async function () {
    const c = { type: 1, auc: 9150, sens: 9100, spec: 9000, rate: 500 };
    expect(await verify(KR, "cd-kr", c)).to.equal(1);
    expect(await verify(US, "cd-us", c)).to.equal(2);
  });

  // C-E: 10.5 % data update -> within KR bound; US borderline band (10-11 %)
  it("C-E (data update, AUC .950, rate 10.5%): Exempt under KR, Borderline under US", async function () {
    const c = { type: 2, auc: 9500, sens: 9200, spec: 9300, rate: 1050 };
    expect(await verify(KR, "ce-kr", c)).to.equal(1);
    expect(await verify(US, "ce-us", c)).to.equal(3);
  });

  // C-F: architecture change -> mandatory approval under BOTH (stage 2)
  it("C-F (architecture change): PendingApproval under both jurisdictions", async function () {
    const c = { type: 4, auc: 9700, sens: 9500, spec: 9600, rate: 300 };
    expect(await verify(KR, "cf-kr", c)).to.equal(4);
    expect(await verify(US, "cf-us", c)).to.equal(4);
  });
});
