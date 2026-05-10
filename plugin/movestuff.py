#!/usr/bin/env python3
# will move the generated files to the right plugin dir (rlly just for main dev guy unless you want to also try to rig ur dev setup to work like this)
import os
import pathlib
import shutil
import time

VAULT_DIR="../convex-sync"
PLUGIN_DIR=".obsidian/plugins"
PLUGIN_NAME="obsidian-sync-engine"

files = [
    "main.js",
    "manifest.json",
    "styles.css",
]

def hotplugin():
    # clone https://github.com/pjeby/hot-reload.git to the vault plugins dir
    plugin = pathlib.Path(f"{VAULT_DIR}/{PLUGIN_DIR}/hot-reload")
    if not plugin.exists():
        print(f"cloning hot-reload to {plugin.absolute()}")
        os.system(f"git clone https://github.com/pjeby/hot-reload.git {plugin.absolute()}")

def movefiles():
    for file in files:
        print(f"moving {file}")
        src = pathlib.Path(f"plugin/{file}")
        dst = pathlib.Path(f"{VAULT_DIR}/{PLUGIN_DIR}/{PLUGIN_NAME}/{file}")
        shutil.copy2(src, dst)
    # ensure .hotreload file exists here too
    hrl = pathlib.Path(f"{VAULT_DIR}/{PLUGIN_DIR}/{PLUGIN_NAME}/.hotreload")
    hrl.touch()

# check file timestamps every second if changed then movefiles()
def checkfiles():
    while True:
        for file in files:
            src = pathlib.Path(f"plugin/{file}")
            dst = pathlib.Path(f"{VAULT_DIR}/{PLUGIN_DIR}/{PLUGIN_NAME}/{file}")
            if src.stat().st_mtime > dst.stat().st_mtime:
                movefiles()
        time.sleep(1)

hotplugin()
print("===== READY =====")
checkfiles()