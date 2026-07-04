# AI-SaMD Regulatory Governance Ontology (PhD Thesis Section 5.3.5)

OWL 2 encoding of the 4-level regulatory ontology (principles ->
requirements -> technical implementations -> validation metrics) covering
KR-DMPA, US FDA PCCP, and EU AI Act + MDR, with two property-chain axioms
deriving `ro:supports` and `ro:traceableTo`.

```bash
pip install rdflib owlrl
python build_and_query.py
```

Pipeline results: 277 asserted triples -> 761 after OWL 2 RL closure
(484 inferred); coverage check 0 unimplemented requirements; all 8 metrics
traceable to principles; jurisdiction-specific ChangePlan parameters
derived from the ontology match the on-chain parameters used in
`test/multi-regulatory.test.js` exactly (`derived-plan-params.json`) —
the ontology serves as the single source of truth for adjudication
parameters.
