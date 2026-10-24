#!/usr/bin/env python3
"""Prepare only a Cloudflared config candidate. Leaves live tunnel unchanged.
Run with sudo because the config may contain privileged credential file paths.
"""
import argparse
import os
import re
import subprocess
from pathlib import Path

CFG = Path("/etc/cloudflared/config.yml")
CANDIDATE = Path("/etc/cloudflared/config.yml.talaeats-legal-candidate")
HOST = "talaeats.alan-palacios-dev.com"
STATIC = "http://127.0.0.1:18191"
NODE = "http://127.0.0.1:18190"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-candidate", action="store_true")
    args=parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("RUN_WITH_SUDO; existing config is private")
    if not CFG.is_file():
        raise SystemExit("CLOUDFLARED_CONFIG_NOT_FOUND")
    original=CFG.read_text(encoding="utf-8")
    lines=original.splitlines(keepends=True)
    hostre=re.compile(r"^(?P<indent>\s*)-\s*hostname:\s*['\"]?talaeats\.alan-palacios-dev\.com['\"]?\s*(?:#.*)?$")
    matches=[i for i,line in enumerate(lines) if hostre.fullmatch(line.rstrip("\r\n"))]
    if len(matches)!=1:
        raise SystemExit("EXPECTED_EXACTLY_ONE_PUBLIC_HOST_RULE: no changes")
    index=matches[0]
    indent=hostre.fullmatch(lines[index].rstrip("\r\n")).group("indent")
    next_index=next((i for i in range(index+1,len(lines))
                     if lines[i].startswith(indent+"- ")),len(lines))
    block="".join(lines[index:next_index])
    if re.search(r"^\s*path\s*:",block,re.M):
        raise SystemExit("UNEXPECTED_EXISTING_PATH_RULE; refuse to guess")
    service_lines=re.findall(r"^\s*service:\s*([^\s#]+)",block,re.M)
    if service_lines != [NODE]:
        raise SystemExit("EXPECTED_NODE_18190_ONLY; refuse to change unrelated origin")
    if STATIC in original:
        raise SystemExit("STATIC_ROUTE_ALREADY_PRESENT; no change")
    new_rule=(indent+"- hostname: "+HOST+"\n"+
              indent+"  path: ^/(privacidad|eliminar-cuenta)/?$\n"+
              indent+"  service: "+STATIC+"\n")
    patched="".join(lines[:index])+new_rule+"".join(lines[index:])
    print("CONFIG_MATCH_CONFIRMED first_target_node_18190=true")
    print("CONFIG_NEW_ROUTE target=127.0.0.1:18191 paths=/privacidad,/eliminar-cuenta")
    print("CONFIG_KEEP_ALL_EXISTING_RULES=true")
    if not args.write_candidate:
        print("PLAN_ONLY; use --write-candidate to create a root-only non-live config")
        return
    if CANDIDATE.exists():
        raise SystemExit("CANDIDATE_EXISTS; inspect before replacement")
    fd=os.open(CANDIDATE, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o600)
    with os.fdopen(fd,"w",encoding="utf-8") as output:
        output.write(patched)
    validations=[
        ["cloudflared","--config",str(CANDIDATE),"tunnel","ingress","validate"],
        ["cloudflared","--config",str(CANDIDATE),"tunnel","ingress","rule","https://"+HOST+"/privacidad"],
        ["cloudflared","--config",str(CANDIDATE),"tunnel","ingress","rule","https://"+HOST+"/eliminar-cuenta"],
        ["cloudflared","--config",str(CANDIDATE),"tunnel","ingress","rule","https://"+HOST+"/api/v1/health"],
    ]
    for idx,args in enumerate(validations):
        result=subprocess.run(args,capture_output=True,text=True,timeout=15)
        output=result.stdout+"\n"+result.stderr
        target=STATIC if idx in (1,2) else NODE
        if result.returncode!=0 or (idx>0 and target not in output):
            print("CLOUDFLARED_CANDIDATE_VALIDATION_FAIL step="+str(idx))
            raise SystemExit(2)
        print("CLOUDFLARED_CANDIDATE_VALIDATION_PASS step="+str(idx))
    print("CANDIDATE_READY "+str(CANDIDATE))
    print("LIVE_CONFIG_UNTOUCHED. Cloudflared HAS NOT restarted; no production requests changed.")

if __name__=="__main__":
    main()
