const { ethers } = require("ethers");
const fs = require("fs");
const art = (n) => JSON.parse(fs.readFileSync(`artifacts/contracts/${n}.sol/${n}.json`));
const OV = { gasPrice: 0, gasLimit: 4000000, type: 0 };
(async () => {
  const p = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { pollingInterval: 100 });
  const w = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d796b4d2c80", p);
  console.log("wallet:", w.address);
  const dep = async (n, ...a) => { const f = new ethers.ContractFactory(art(n).abi, art(n).bytecode, w); const c = await f.deploy(...a, OV); await c.waitForDeployment(); return c; };
  const reg = await dep("SaMDRegistry"); const aud = await dep("AuditTrail");
  const ver = await dep("ChangeVerifier", await reg.getAddress(), await aud.getAddress());
  await (await reg.setChangeVerifier(await ver.getAddress(), OV)).wait();
  await (await aud.setChangeVerifier(await ver.getAddress(), OV)).wait();
  await (await reg.grantRole(w.address, 1, OV)).wait();
  const PID = ethers.id("DIAG");
  await (await reg.registerProduct(PID, 2, 1, true, ethers.id("v0"), OV)).wait();
  // plan 없음 -> verifyChange는 NonExempt 경로 (plan 미제출)
  for (let i = 0; i < 3; i++) {
    const bn0 = await p.getBlockNumber();
    const t0 = Date.now();
    const tx = await ver.verifyChange(PID, 2, 9500, 9200, 9300, 3000, ethers.id("v0"), ethers.id("v" + i), ethers.id("e" + i), OV);
    const tSend = Date.now() - t0;
    const r = await tx.wait();
    console.log(`verifyChange#${i}: total=${Date.now() - t0}ms (send=${tSend}ms) submitBlk=${bn0} inclBlk=${r.blockNumber} (+${Number(r.blockNumber) - bn0}) gas=${r.gasUsed}`);
  }
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
