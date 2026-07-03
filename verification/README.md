# Verification Artifacts (PhD Thesis Section 4.2.5–4.2.6)

## Static analysis — Slither 0.11.5
```bash
pip install slither-analyzer
slither .          # uses the hardhat project (viaIR enabled)
```
Full report: `slither-report.txt` (19 results, 0 High/Critical — triage in thesis Table 4-6).

## Formal verification — solc SMTChecker (CHC engine + Z3 4.11.2)
The official solc binaries do not bundle Z3; use the pinned Docker image:
```bash
docker build -f Dockerfile.smtchecker -t solc-z3:0.8.19 .
docker run --rm -v "$PWD/../contracts:/src" -w /src solc-z3:0.8.19 \
  --via-ir --optimize --model-checker-engine chc \
  --model-checker-contracts "ChangeVerifier.sol:ChangeVerifier" \
  --model-checker-targets "overflow,underflow,divByZero,popEmptyArray,outOfBounds" \
  --model-checker-timeout 20000 --model-checker-show-unproved \
  ChangeVerifier.sol SaMDRegistry.sol AuditTrail.sol
```
Reports: `smt-SaMDRegistry-raw.txt` (all targets proved), `smt-ChangeVerifier.txt`,
`smt-AuditTrail.txt` (unproved items are proof-timeouts, not counterexamples).

## Property-based differential fuzzing
```bash
npx hardhat test test/property-fuzz.test.js   # 2,000 checks, seed 20260704
```
The initial run of this suite exposed a branch defect (disallowed change type
combined with a borderline data-change rate returned `Borderline` instead of
`NonExempt`); fixed in `ChangeVerifier.sol` by adding the `typeOK` conjunct to
the borderline condition (thesis Section 4.2.6).
