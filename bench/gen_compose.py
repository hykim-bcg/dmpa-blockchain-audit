# -*- coding: utf-8 -*-
"""Generate docker-compose.yml + static-nodes.json for netN (IBFT 2.0)."""
import json, os, subprocess, sys

N = int(sys.argv[1])
net = f"net{N}"
subnet3 = f"172.28.{N}"
keys_dir = os.path.join(net, "networkFiles", "keys")
addrs = sorted(os.listdir(keys_dir))
assert len(addrs) == N

def pubkey(addr):
    keydir = os.path.abspath(os.path.join(keys_dir, addr)).replace("\\", "/")
    out = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{keydir}:/keys",
         "hyperledger/besu:24.12.2", "public-key", "export",
         "--node-private-key-file=/keys/key"],
        capture_output=True, text=True, env={**os.environ, "MSYS_NO_PATHCONV": "1"})
    for line in (out.stdout + out.stderr).splitlines():
        line = line.strip()
        if line.startswith("0x") and len(line) == 130:
            return line[2:]
    raise RuntimeError(out.stdout + out.stderr)

ips = [f"{subnet3}.{11+i}" for i in range(N)]
enodes = []
for i, addr in enumerate(addrs):
    pk = pubkey(addr)
    enodes.append(f"enode://{pk}@{ips[i]}:30303")
with open(os.path.join(net, "static-nodes.json"), "w") as f:
    json.dump(enodes, f, indent=1)

services = []
for i, addr in enumerate(addrs):
    port = "    ports: [\"8545:8545\"]\n" if i == 0 else ""
    bootflag = "" if i == 0 else f"\n      --bootnodes={enodes[0]}"
    services.append(f"""  node{i+1}:
    image: hyperledger/besu:24.12.2
    command: >
      --genesis-file=/config/genesis.json
      --node-private-key-file=/keys/key
      --data-path=/opt/besu/data
      --p2p-host={ips[i]}{bootflag}
      --rpc-http-enabled --rpc-http-host=0.0.0.0
      --rpc-http-api=ETH,NET,TXPOOL,IBFT
      --host-allowlist=*
      --min-gas-price=0
      --logging=ERROR
    volumes:
      - ./networkFiles/genesis.json:/config/genesis.json
      - ./static-nodes.json:/config/static-nodes.json
      - ./networkFiles/keys/{addr}:/keys
{port}    networks:
      besunet{N}:
        ipv4_address: {ips[i]}
""")

compose = "services:\n" + "".join(services) + f"""
networks:
  besunet{N}:
    ipam:
      config:
        - subnet: {subnet3}.0/24
"""
with open(os.path.join(net, "docker-compose.yml"), "w") as f:
    f.write(compose)
print(f"{net}: compose + static-nodes for {N} validators")
