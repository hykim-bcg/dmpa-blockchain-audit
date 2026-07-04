const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Composite-change adjudication (PhD thesis Sections 3.1.5(4) and 4.2.8)
 *
 * Composition rule (most-restrictive-wins) over the restrictiveness order
 *   NotApplicable < Exempt < Borderline < NonExempt < PendingApproval
 *
 * Two independent formulations are checked for equivalence:
 *  (a) holistic reference formula: typeOK(C) = ALL component types allowed,
 *      shared metrics evaluated once;
 *  (b) on-chain per-component verdicts composed by max-restrictiveness.
 *
 * Verified: 5 targeted cases + 300 randomized composites (fixed seed).
 */

const RANK = { 0: 0, 1: 1, 3: 2, 2: 3, 4: 4 }; // NotApp<Exempt<Borderline<NonExempt<Pending
const maxRestrictive = (verdicts) =>
  verdicts.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));

// holistic composite reference (specification of thesis 3.1.5(4))
function compositeReference(aiEnabled, plan, types, m) {
  if (types.some((x) => x >= 4 && x <= 7)) return 4;          // any major -> Pending
  const conditional = types.filter((x) => x >= 1 && x <= 3);
  if (conditional.length === 0) return 0;                      // only minor (8,9)
  if (!aiEnabled) return 2;
  if (!plan || !plan.approved) return 2;
  const typeOK = conditional.every((x) => plan.allowedChangeTypes.includes(x));
  const perfOK = m.auc >= plan.minAUC && m.sens >= plan.minSensitivity
              && m.spec >= plan.minSpecificity;
  const dataOK = m.rate <= plan.maxDataChangeRate;
  if (typeOK && perfOK && dataOK) return 1;
  if (!perfOK) return 2;
  if (typeOK && !dataOK &&
      m.rate <= Math.floor((plan.maxDataChangeRate * 110) / 100)) return 3;
  return 2;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(9102026);
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

describe("Composite Change — most-restrictive-wins composition", function () {
  this.timeout(600000);
  let registry, verifier, auditTrail;
  let admin, manufacturer, mfds;
  let seq = 0;

  async function onchainVerdict(pid, state, type, m) {
    const newHash = ethers.id(`comp-${seq++}`);
    const tx = await verifier.connect(manufacturer).verifyChange(
      pid, type, m.auc, m.sens, m.spec, m.rate,
      state.hash, newHash, ethers.id(`comp-ev-${seq}`));
    const receipt = await tx.wait();
    const ev = receipt.logs.find((log) => {
      try { return verifier.interface.parseLog(log)?.name === "ChangeVerified"; }
      catch { return false; }
    });
    const v = Number(verifier.interface.parseLog(ev).args.result);
    if (v === 1) state.hash = newHash;                 // Exempt updates the hash
    return v;
  }

  async function setupProduct(k, plan) {
    const pid = ethers.id(`COMP-P${k}`);
    const h0 = ethers.id(`COMP-P${k}-v0`);
    await registry.connect(manufacturer).registerProduct(pid, 2, 1, plan.aiEnabled, h0);
    if (plan.kind !== "none") {
      const pl = ethers.id(`COMP-PLAN${k}`);
      await registry.connect(manufacturer).submitChangePlan(
        pl, pid, plan.minAUC, plan.minSensitivity, plan.minSpecificity,
        plan.maxDataChangeRate, plan.allowedChangeTypes);
      if (plan.kind === "approved") await registry.connect(mfds).approvePlan(pl);
    }
    return { pid, state: { hash: h0 } };
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
  });

  it("adjudicates 5 targeted composite cases per the composition rule", async function () {
    const plan = { aiEnabled: true, kind: "approved", minAUC: 9000,
      minSensitivity: 8500, minSpecificity: 8500, maxDataChangeRate: 2000,
      allowedChangeTypes: [1, 2] };
    const { pid, state } = await setupProduct(1000, plan);
    const refPlan = { ...plan, approved: true };
    const m = { auc: 9400, sens: 9100, spec: 9200, rate: 1000 };

    const cases = [
      { types: [1, 2], m, want: 1 },                                   // all in scope -> Exempt
      { types: [1, 4], m, want: 4 },                                   // contains major -> Pending
      { types: [1, 3], m, want: 2 },                                   // type 3 not allowed -> NonExempt
      { types: [1, 2], m: { ...m, rate: 2100 }, want: 3 },             // marginal rate -> Borderline
      { types: [8, 9], m, want: 0 },                                   // only minor -> NotApplicable
    ];
    for (const c of cases) {
      const ref = compositeReference(plan.aiEnabled, refPlan, c.types, c.m);
      expect(ref, `reference ${JSON.stringify(c.types)}`).to.equal(c.want);
      const parts = [];
      for (const ty of c.types) parts.push(await onchainVerdict(pid, state, ty, c.m));
      expect(maxRestrictive(parts), `on-chain ${JSON.stringify(c.types)}`).to.equal(c.want);
    }
  });

  it("300 randomized composites: holistic reference == max-restrictive of on-chain parts", async function () {
    let mismatches = 0, done = 0;
    for (let k = 0; k < 30; k++) {
      const variant = k % 10;
      const nTypes = ri(1, 3);
      const pool = [1, 2, 3];
      const allowed = [];
      for (let i = 0; i < nTypes; i++)
        allowed.push(pool.splice(ri(0, pool.length - 1), 1)[0]);
      const plan = {
        aiEnabled: variant !== 8, kind: variant === 9 ? "submitted" : "approved",
        minAUC: ri(8000, 9600), minSensitivity: ri(8000, 9600),
        minSpecificity: ri(8000, 9600), maxDataChangeRate: ri(800, 3000),
        allowedChangeTypes: allowed.sort(),
      };
      const { pid, state } = await setupProduct(k, plan);
      const refPlan = plan.kind === "none" ? null : { ...plan, approved: plan.kind === "approved" };

      for (let j = 0; j < 10; j++) {
        const nComp = ri(2, 3);
        const types = [];
        while (types.length < nComp) {
          const ty = ri(1, 9);
          if (!types.includes(ty)) types.push(ty);
        }
        const near = j % 2 === 0;
        const m = {
          auc: near ? Math.max(0, plan.minAUC + ri(-300, 300)) : ri(0, 10000),
          sens: near ? Math.max(0, plan.minSensitivity + ri(-300, 300)) : ri(0, 10000),
          spec: near ? Math.max(0, plan.minSpecificity + ri(-300, 300)) : ri(0, 10000),
          rate: near ? Math.max(0, plan.maxDataChangeRate + ri(-400, 400)) : ri(0, 5000),
        };
        const ref = compositeReference(plan.aiEnabled, refPlan, types, m);
        const parts = [];
        for (const ty of types) parts.push(await onchainVerdict(pid, state, ty, m));
        if (maxRestrictive(parts) !== ref) mismatches++;
        done++;
      }
    }
    console.log(`      -> composite equivalence: ${done - mismatches}/${done}`);
    expect(mismatches).to.equal(0);
  });
});
