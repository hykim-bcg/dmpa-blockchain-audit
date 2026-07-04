# -*- coding: utf-8 -*-
"""AI-SaMD Regulatory Governance Ontology — reasoning & derivation pipeline.

PhD thesis Section 5.3.5:
  1. Load the OWL 2 encoding (regulatory-ontology.ttl)
  2. Compute the OWL 2 RL deductive closure (owlrl) — property-chain
     inference derives ro:supports and ro:traceableTo
  3. Q1 coverage check : requirements lacking an implementation (expect 0)
  4. Q2 inference      : implementations supporting each principle (derived)
  5. Q3 traceability   : metric -> principle chains (derived)
  6. Q4 derivation     : jurisdiction-specific ChangePlan parameters
     exported as JSON and asserted equal to the on-chain test parameters
     of Section 4.2.7 (ontology as the single source of truth)

Run:  python -X utf8 build_and_query.py
"""
import json
from rdflib import Graph, Namespace
from owlrl import DeductiveClosure, OWLRL_Semantics

RO = Namespace("https://w3id.org/ai-samd-governance/regonto#")

g = Graph()
g.parse("regulatory-ontology.ttl", format="turtle")
n_asserted = len(g)
DeductiveClosure(OWLRL_Semantics).expand(g)
n_closed = len(g)
print(f"[온톨로지] 명시 트리플 {n_asserted}개 -> OWL 2 RL 폐포 후 {n_closed}개 "
      f"(추론 도출 {n_closed - n_asserted}개)")

def rows(q):
    return list(g.query(q, initNs={"ro": RO, "rdfs":
        Namespace("http://www.w3.org/2000/01/rdf-schema#")}))

# ── Q1: 커버리지 — 구현이 없는 요구사항 (기대: 0건) ──────────────
q1 = rows("""
SELECT ?req WHERE {
  ?req a ro:RegulatoryRequirement .
  FILTER NOT EXISTS { ?impl ro:implements ?req . }
}""")
print(f"\n[Q1 커버리지] 구현 메커니즘이 없는 요구사항: {len(q1)}건")
assert len(q1) == 0, [str(r.req) for r in q1]

# ── Q2: 추론 — 원칙별 뒷받침 기술 (implements ∘ realizes ⊑ supports) ──
q2 = rows("""
SELECT ?pl ?il WHERE {
  ?impl ro:supports ?p .
  ?p rdfs:label ?pl . ?impl rdfs:label ?il .
  FILTER(lang(?pl) = "ko" && lang(?il) = "ko")
} ORDER BY ?pl ?il""")
print(f"\n[Q2 추론: ro:supports — 속성 연쇄로 도출, {len(q2)}쌍]")
cur = None
for r in q2:
    if str(r.pl) != cur:
        cur = str(r.pl); print(f"  원칙 '{cur}' <-")
    print(f"      {r.il}")

# ── Q3: 추론 — 메트릭→원칙 추적 체인 (validates ∘ supports ⊑ traceableTo) ──
q3 = rows("""
SELECT (COUNT(DISTINCT ?m) AS ?nm) (COUNT(*) AS ?np) WHERE {
  ?m ro:traceableTo ?p .
}""")
nm, np_ = int(q3[0][0]), int(q3[0][1])
print(f"\n[Q3 추적성] 메트릭 {nm}개 전부가 원칙까지 추적됨 (메트릭-원칙 쌍 {np_}개)")
q3b = rows("SELECT (COUNT(DISTINCT ?m) AS ?n) WHERE { ?m a ro:ValidationMetric . }")
assert nm == int(q3b[0][0]), "추적되지 않는 메트릭 존재"

# ── Q4: 파라미터 도출 — 온톨로지 -> JSON -> 4.2.7 검증 파라미터 대조 ──
def derive(juris):
    q = rows(f"""
    SELECT ?a ?s ?p ?r (GROUP_CONCAT(?t; separator=",") AS ?types) WHERE {{
      ?ps a ro:PlanParameterSet ; ro:appliesTo ro:{juris} ;
          ro:minAUC ?a ; ro:minSensitivity ?s ; ro:minSpecificity ?p ;
          ro:maxDataChangeRate ?r ; ro:allowedChangeType ?t .
    }} GROUP BY ?a ?s ?p ?r""")
    r = q[0]
    return {"jurisdiction": juris, "minAUC": int(r.a), "minSensitivity": int(r.s),
            "minSpecificity": int(r.p), "maxDataChangeRate": int(r.r),
            "allowedChangeTypes": sorted(int(x) for x in str(r.types).split(","))}

derived = {j: derive(j) for j in ("KR", "US")}
print("\n[Q4 파라미터 도출] 온톨로지 -> ChangePlan 파라미터 JSON:")
print(json.dumps(derived, ensure_ascii=False, indent=2))

# 4.2.7절 multi-regulatory.test.js에 적재된 온체인 파라미터와의 동일성 검증
onchain_427 = {
    "KR": {"jurisdiction": "KR", "minAUC": 9000, "minSensitivity": 8500,
           "minSpecificity": 8500, "maxDataChangeRate": 2000, "allowedChangeTypes": [1, 2, 3]},
    "US": {"jurisdiction": "US", "minAUC": 9300, "minSensitivity": 9000,
           "minSpecificity": 8800, "maxDataChangeRate": 1000, "allowedChangeTypes": [1, 2]},
}
assert derived == onchain_427, "온톨로지 파라미터와 4.2.7 온체인 파라미터 불일치"
print("\n[Q4 대조] 도출 파라미터 == 4.2.7절 온체인 검증 파라미터 (KR·US 완전 일치)")

with open("derived-plan-params.json", "w", encoding="utf-8") as f:
    json.dump(derived, f, ensure_ascii=False, indent=2)
print("derived-plan-params.json 저장 완료")
