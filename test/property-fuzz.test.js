const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Property-based differential testing (PhD thesis Section 4.2.6)
 *
 * A JavaScript reference model encodes the *specification* of Algorithm 1
 * (DMPA Enforcement Rule Art. 23(2) exemption; design principles in thesis
 * Section 3.1.5). Thousands of pseudo-random change submissions are executed
 * against both the reference model and the on-chain ChangeVerifier, and the
 * verdicts are compared (QuickCheck-style differential testing).
 *
 * Invariants additionally checked on every call:
 *   I1  verdict equals the reference-model verdict
 *   I2  currentModelHash is updated  iff  verdict == Exempt
 *   I3  every call appends exactly one audit record (complete-recording)
 *
 * Deterministic PRNG (mulberry32, fixed seed) => fully reproducible.
 */

// ─────────────────── deterministic PRNG ───────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260704;
const rnd = mulberry32(SEED);
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)); // inclusive

// ─────────────────── reference model (specification) ───────────────────
// VerificationResult: 0 NotApplicable, 1 Exempt, 2 NonExempt, 3 Borderline, 4 PendingApproval
function referenceVerdict(aiEnabled, plan, c) {
  if (c.changeType === 8 || c.changeType === 9) return 0;         // Stage 1
  if (c.changeType >= 4 && c.changeType <= 7) return 4;           // Stage 2
  if (!aiEnabled) return 2;                                        // Stage 3 req1
  if (!plan || !plan.approved) return 2;                           // Stage 3 req2
  const typeOK = plan.allowedChangeTypes.includes(c.changeType);   // Stage 4
  const perfOK = c.auc >= plan.minAUC && c.sens >= plan.minSensitivity
              && c.spec >= plan.minSpecificity;
  const dataOK = c.rate <= plan.maxDataChangeRate;
  if (typeOK && perfOK && dataOK) return 1;                        // Exempt
  if (!perfOK) return 2;                                           // safety first
  // Borderline (design principle 3): allowed type, performance OK,
  // data rate marginally exceeded (<= 110 % of the plan maximum)
  if (typeOK && !dataOK &&
      c.rate <= Math.floor((plan.maxDataChangeRate * 110) / 100)) return 3;
  return 2;                                                        // NonExempt
}

// ─────────────────── fuzz configuration ───────────────────
const N_PLANS = 40;          // random plan configurations
const N_CHANGES = 50;        // random changes per plan
const NAME = ["NotApplicable", "Exempt", "NonExempt", "Borderline", "PendingApproval"];

function randomPlan(k) {
  const variant = k % 10;
  const aiEnabled = variant !== 7;                 // ~10 % non-AI products
  const planKind = variant === 8 ? "none" : variant === 9 ? "submitted" : "approved";
  const nTypes = ri(1, 3);   // SaMDRegistry rejects empty allowedChangeTypes
  const pool = [1, 2, 3];
  const allowed = [];
  for (let i = 0; i < nTypes; i++) {
    const t = pool.splice(ri(0, pool.length - 1), 1)[0];
    allowed.push(t);
  }
  return {
    aiEnabled, planKind,
    minAUC: ri(7000, 9800), minSensitivity: ri(7000, 9800),
    minSpecificity: ri(7000, 9800), maxDataChangeRate: ri(500, 4000),
    allowedChangeTypes: allowed.sort(),
  };
}

function randomChange(plan, j) {
  const changeType = ri(1, 9);
  // half of the samples are steered near the plan thresholds to stress
  // boundary combinations (including the 100-110 % borderline band)
  const near = j % 2 === 0;
  const nearv = (base) => Math.max(0, Math.min(65535, base + ri(-300, 300)));
  const rateNear = () => {
    const m = plan.maxDataChangeRate;
    const band = ri(0, 3);
    if (band === 0) return ri(0, m);                                   // within
    if (band === 1) return ri(m + 1, Math.floor((m * 110) / 100) + 1); // ~borderline
    if (band === 2) return nearv(m);
    return ri(Math.floor((m * 110) / 100) + 1, Math.min(65535, m * 2 + 10));
  };
  return {
    changeType,
    auc: near ? nearv(plan.minAUC) : ri(0, 10000),
    sens: near ? nearv(plan.minSensitivity) : ri(0, 10000),
    spec: near ? nearv(plan.minSpecificity) : ri(0, 10000),
    rate: near ? rateNear() : ri(0, 6000),
  };
}

describe("Property-Based Differential Fuzzing — Algorithm 1 vs Reference Model", function () {
  this.timeout(1200000);
  let registry, verifier, auditTrail;
  let admin, manufacturer, mfds;

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
  });

  it(`runs ${N_PLANS} plans x ${N_CHANGES} changes = ${N_PLANS * N_CHANGES} differential checks`, async function () {
    const mismatches = [];
    let checks = 0;

    for (let k = 0; k < N_PLANS; k++) {
      const plan = randomPlan(k);
      const PID = ethers.id(`FUZZ-P${k}`);
      const initialHash = ethers.id(`FUZZ-P${k}-model-v0`);
      await registry.connect(manufacturer).registerProduct(
        PID, 2, 1, plan.aiEnabled, initialHash);

      if (plan.planKind !== "none") {
        const PLN = ethers.id(`FUZZ-PLAN${k}`);
        await registry.connect(manufacturer).submitChangePlan(
          PLN, PID, plan.minAUC, plan.minSensitivity, plan.minSpecificity,
          plan.maxDataChangeRate, plan.allowedChangeTypes);
        if (plan.planKind === "approved") await registry.connect(mfds).approvePlan(PLN);
      }
      const refPlan = plan.planKind === "none" ? null :
        { ...plan, approved: plan.planKind === "approved" };

      let currentHash = initialHash;
      for (let j = 0; j < N_CHANGES; j++) {
        const c = randomChange(plan, j);
        const newHash = ethers.id(`FUZZ-P${k}-model-${j + 1}`);
        const before = await auditTrail.getChangeHistory(PID);

        const tx = await verifier.connect(manufacturer).verifyChange(
          PID, c.changeType, c.auc, c.sens, c.spec, c.rate,
          currentHash, newHash, ethers.id(`FUZZ-EV-${k}-${j}`));
        const receipt = await tx.wait();
        const ev = receipt.logs.find((log) => {
          try { return verifier.interface.parseLog(log)?.name === "ChangeVerified"; }
          catch { return false; }
        });
        const got = Number(verifier.interface.parseLog(ev).args.result);
        const want = referenceVerdict(plan.aiEnabled, refPlan, c);
        checks++;

        // I1 — differential equivalence
        if (got !== want) {
          mismatches.push({ plan: k, case: j, input: c,
            allowed: plan.allowedChangeTypes, maxRate: plan.maxDataChangeRate,
            got: NAME[got], want: NAME[want] });
        }
        // I2 — model hash updated iff Exempt
        const p = await registry.getProduct(PID);
        if (got === 1) {
          expect(p.currentModelHash).to.equal(newHash);
          currentHash = newHash;
        } else {
          expect(p.currentModelHash).to.equal(currentHash);
        }
        // I3 — exactly one audit record appended
        const after = await auditTrail.getChangeHistory(PID);
        expect(after.length).to.equal(before.length + 1);
      }
    }

    if (mismatches.length > 0) {
      console.log(`      -> MISMATCHES: ${mismatches.length}/${checks}`);
      for (const m of mismatches.slice(0, 5)) console.log("        ", JSON.stringify(m));
    } else {
      console.log(`      -> all ${checks} differential checks passed (seed=${SEED})`);
    }
    expect(mismatches, `spec-implementation divergence in ${mismatches.length} cases`).to.deep.equal([]);
  });
});
