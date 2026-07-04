# -*- coding: utf-8 -*-
"""SHACL constraint validation for the regulatory ontology (thesis 5.3.5).

1. Validate regulatory-ontology.ttl against shapes.ttl  -> expect CONFORMS
2. Negative test: inject a deliberately defective PlanParameterSet
   (jurisdiction missing, minAUC out of range, disallowed change type 5)
   -> expect violations to be detected and reported

Run:  python -X utf8 validate_shapes.py
"""
from rdflib import Graph
from pyshacl import validate

shapes = Graph().parse("shapes.ttl", format="turtle")

# ── 1) 본 온톨로지 적합성 ─────────────────────────────────────
data = Graph().parse("regulatory-ontology.ttl", format="turtle")
conforms, _, _ = validate(data, shacl_graph=shapes, inference="rdfs")
print(f"[SHACL 1] regulatory-ontology.ttl: {'CONFORMS (위반 0건)' if conforms else 'VIOLATIONS'}")
assert conforms

# ── 2) 음성 대조: 결함 파라미터 세트 주입 ────────────────────
BAD = """
@prefix ro:  <https://w3id.org/ai-samd-governance/regonto#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ro:Broken-PlanParams a ro:PlanParameterSet ;
    ro:minAUC 12000 ;                # 범위 초과 (>10000)
    ro:minSensitivity 8500 ;
    ro:minSpecificity 8500 ;
    ro:maxDataChangeRate 2000 ;
    ro:allowedChangeType 5 .         # 중대 변경 유형 -> 계획 대상 아님
    # appliesTo·derivedFromRequirement 누락
"""
bad = Graph().parse("regulatory-ontology.ttl", format="turtle")
bad.parse(data=BAD, format="turtle")
conforms2, report_graph, report_text = validate(bad, shacl_graph=shapes, inference="rdfs")
n_viol = report_text.count("Constraint Violation")
print(f"[SHACL 2] 결함 주입 사례: {'미검출 (문제!)' if conforms2 else f'위반 {n_viol}건 검출'}")
assert not conforms2 and n_viol >= 4
for line in report_text.splitlines():
    if "Message:" in line:
        print("   -", line.strip().replace("Message: ", ""))
print("\n결론: 결함 파라미터는 파이프라인 진입 전 SHACL 게이트에서 차단됨")
