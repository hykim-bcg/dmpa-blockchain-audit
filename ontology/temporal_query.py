# -*- coding: utf-8 -*-
"""Temporal query demo — 시점별 유효 조문의 기계적 재구성 (thesis 5.3.5).

소급 감사 시나리오: "판정 시점 t에 유효했던 조문 버전은 무엇인가?"
과거 판정 기록(블록 타임스탬프)의 법적 근거를 시점 기준으로 복원한다.

Run:  python -X utf8 temporal_query.py
"""
from rdflib import Graph, Namespace

RO = Namespace("https://w3id.org/ai-samd-governance/regonto#")
g = Graph()
g.parse("regulatory-ontology.ttl", format="turtle")
g.parse("temporal-versioning.ttl", format="turtle")

Q = """
PREFIX ro: <https://w3id.org/ai-samd-governance/regonto#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?label ?instrument WHERE {
  ?abstract ro:hasVersion ?v .
  ?abstract ro:provisionRef ?ref .
  ?v rdfs:label ?label ; ro:instrumentRef ?instrument ;
     ro:validFrom ?from .
  OPTIONAL { ?v ro:validUntil ?until . }
  FILTER(?ref = "DMPA 시행규칙 제23조 제2항")
  FILTER(?from <= ?t && (!BOUND(?until) || ?t <= ?until))
  FILTER(lang(?label) = "ko")
}
"""

from rdflib.plugins.sparql import prepareQuery
from rdflib import Literal, XSD
q = prepareQuery(Q, initNs={"ro": RO, "rdfs": Namespace("http://www.w3.org/2000/01/rdf-schema#")})

for t in ("2025-06-01", "2026-07-04"):
    rows = list(g.query(q, initBindings={"t": Literal(t, datatype=XSD.date)}))
    assert len(rows) == 1, f"{t}: 유효 버전이 정확히 1개여야 함 (got {len(rows)})"
    print(f"판정 시점 {t} -> 유효 조문: {rows[0].label}")
    print(f"                근거 법령: {rows[0].instrument}")

# 대체 체인 검증: 각 추상 조문마다 개방 구간(현행) 버전이 정확히 1개
open_q = """
PREFIX ro: <https://w3id.org/ai-samd-governance/regonto#>
SELECT ?abstract (COUNT(?v) AS ?n) WHERE {
  ?abstract ro:hasVersion ?v .
  FILTER NOT EXISTS { ?v ro:validUntil ?u . }
} GROUP BY ?abstract
"""
for row in g.query(open_q):
    assert int(row.n) == 1
print("\n대체 체인 무결성: 추상 조문별 현행(개방 구간) 버전 정확히 1개 — 확인")
print("결론: 과거 판정 기록의 법적 근거를 판정 시점 기준으로 기계적으로 복원 가능 (소급 감사)")
