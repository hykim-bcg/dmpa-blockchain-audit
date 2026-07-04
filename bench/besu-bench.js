/**
 * Besu IBFT 2.0 multi-node consensus benchmark (PhD thesis Section 4.5.4)
 *
 * Against a running Besu network (RPC on localhost:8545):
 *  1. deploys SaMDRegistry / AuditTrail / ChangeVerifier and wires roles
 *  2. latency phase   : NL sequential verifyChange txs, per-tx submit->receipt
 *  3. throughput phase: NT concurrent verifyChange txs (nonce-ordered burst),
 *     first-submit -> last-receipt wall time, blocks spanned
 *
 * Usage: node bench/besu-bench.js <label>          (run from repo root)
 * Env  : RPC (default http://127.0.0.1:8545)
 */
const { ethers } = require("ethers");
const fs = require("fs");

const RPC = process.env.RPC || "http://127.0.0.1:8545";
const LABEL = process.argv[2] || "net";
const NL = 20;    // latency samples
const NT = 200;   // throughput burst size

// well-known dev keys (funded / zero-gas-price network)
const K_MANUF = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d796b4d2c80";
const K_MFDS  = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const art = (n) => JSON.parse(fs.readFileSync(`artifacts/contracts/${n}.sol/${n}.json`));
const OV = { gasPrice: 1_000_000_000, gasLimit: 4_000_000, type: 0 };

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { polling: true, pollingInterval: 150 });
  const manuf = new ethers.Wallet(K_MANUF, provider);
  const mfds = new ethers.Wallet(K_MFDS, provider);

  const deploy = async (name, ...args) => {
    const f = new ethers.ContractFactory(art(name).abi, art(name).bytecode, manuf);
    const c = await f.deploy(...args, OV);
    await c.waitForDeployment();
    return c;
  };

  const t0 = Date.now();
  const reg = await deploy("SaMDRegistry");
  const aud = await deploy("AuditTrail");
  const ver = await deploy("ChangeVerifier", await reg.getAddress(), await aud.getAddress());
  await (await reg.setChangeVerifier(await ver.getAddress(), OV)).wait();
  await (await aud.setChangeVerifier(await ver.getAddress(), OV)).wait();
  await (await reg.grantRole(manuf.address, 1, OV)).wait();
  await (await reg.grantRole(mfds.address, 2, OV)).wait();

  const RUN = `${LABEL}-${Date.now()}`;
  const PID = ethers.id(`BENCH-${RUN}`);
  await (await reg.registerProduct(PID, 2, 1, true, ethers.id("m-v0"), OV)).wait();
  await (await reg.submitChangePlan(ethers.id(`PL-${RUN}`), PID,
    9000, 8500, 8500, 2000, [1, 2, 3], OV)).wait();
  await (await reg.connect(mfds).approvePlan(ethers.id(`PL-${RUN}`), OV)).wait();
  const setupMs = Date.now() - t0;

  // NonExempt-path payload (rate > 110% of max): no model-hash update,
  // so every tx is state-independent and burst-safe.
  const send = (nonce) => ver.verifyChange(
    PID, 2, 9500, 9200, 9300, 3000,
    ethers.id("m-v0"), ethers.id(`m-${nonce}`), ethers.id(`ev-${nonce}`),
    { ...OV, nonce });

  // ── latency phase (sequential) ─────────────────────────────
  const lat = [];
  for (let i = 0; i < NL; i++) {
    const s = Date.now();
    const tx = await send(await provider.getTransactionCount(manuf.address));
    await tx.wait();
    lat.push(Date.now() - s);
  }

  // ── throughput phase (pre-signed parallel burst) ───────────
  // pre-sign NT raw txs so client-side signing/serialization is
  // excluded from the measured window; submit concurrently
  let nonce = await provider.getTransactionCount(manuf.address);
  const raws = [];
  for (let i = 0; i < NT; i++) {
    const txReq = await ver.verifyChange.populateTransaction(
      PID, 2, 9500, 9200, 9300, 3000,
      ethers.id("m-v0"), ethers.id(`m-${nonce}`), ethers.id(`ev-${nonce}`),
      { ...OV, nonce, chainId: (await provider.getNetwork()).chainId });
    raws.push(await manuf.signTransaction(txReq));
    nonce++;
  }
  const s2 = Date.now();
  const hashes = await Promise.all(
    raws.map((r) => provider.send("eth_sendRawTransaction", [r])));
  const rcs = await Promise.all(hashes.map(async (h) => {
    for (;;) {
      const r = await provider.getTransactionReceipt(h);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 200));
    }
  }));
  const wall = (Date.now() - s2) / 1000;

  const blocks = rcs.map((r) => Number(r.blockNumber));
  const b0 = Math.min(...blocks), b1 = Math.max(...blocks);
  const gasUsed = rcs.reduce((a, r) => a + Number(r.gasUsed), 0);

  const result = {
    label: LABEL, rpc: RPC,
    setup_ms: setupMs,
    latency_ms: {
      n: NL,
      mean: Math.round(lat.reduce((a, b) => a + b) / NL),
      median: pct(lat, 50), p95: pct(lat, 95),
      min: Math.min(...lat), max: Math.max(...lat),
    },
    throughput: {
      n: NT, wall_s: Number(wall.toFixed(2)),
      tps: Number((NT / wall).toFixed(1)),
      blocks_spanned: b1 - b0 + 1,
      tx_per_block: Number((NT / (b1 - b0 + 1)).toFixed(1)),
      avg_gas_per_tx: Math.round(gasUsed / NT),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  fs.appendFileSync("bench/results.jsonl", JSON.stringify(result) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
