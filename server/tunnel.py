#!/usr/bin/env python3
# use cloudflared to create a tunnel to the convex server

import os
import subprocess
import pathlib


env = pathlib.Path("server/.env")
if not env.exists():
    print("missing .env file")
    exit(1)

with open(env) as f:
    for line in f:
        if line.startswith("CLOUDFLARE_API_TOKEN="):
            token = line.split("=")[1].strip()

print(f"using token {token}")
subprocess.run(["cloudflared", "tunnel", "run", "--token", token])


