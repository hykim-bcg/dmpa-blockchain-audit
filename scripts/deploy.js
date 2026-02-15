const hre = require("hardhat");

async function main() {
  const [deployer, manufacturer, mfds] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // 1. Deploy SaMDRegistry
  const SaMDRegistry = await hre.ethers.getContractFactory("SaMDRegistry");
  const registry = await SaMDRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("SaMDRegistry deployed to:", registryAddr);

  // 2. Deploy AuditTrail
  const AuditTrail = await hre.ethers.getContractFactory("AuditTrail");
  const auditTrail = await AuditTrail.deploy();
  await auditTrail.waitForDeployment();
  const auditTrailAddr = await auditTrail.getAddress();
  console.log("AuditTrail deployed to:", auditTrailAddr);

  // 3. Deploy ChangeVerifier
  const ChangeVerifier = await hre.ethers.getContractFactory("ChangeVerifier");
  const verifier = await ChangeVerifier.deploy(registryAddr, auditTrailAddr);
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("ChangeVerifier deployed to:", verifierAddr);

  // 4. Wire cross-contract references
  await registry.setChangeVerifier(verifierAddr);
  await auditTrail.setChangeVerifier(verifierAddr);
  console.log("Cross-contract references set");

  // 5. Grant roles
  if (manufacturer) {
    await registry.grantRole(manufacturer.address, 1); // Manufacturer
    console.log("Manufacturer role granted to:", manufacturer.address);
  }
  if (mfds) {
    await registry.grantRole(mfds.address, 2); // MFDS
    console.log("MFDS role granted to:", mfds.address);
  }

  console.log("\nDeployment complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
