#!/usr/bin/env python3
"""
Upload princeplayer server.js + client/dist to production via Paramiko (password SSH).

Usage (password never stored in repo):
  export PRINCE_SSH_PASS='your-ssh-password'
  npm run build   # from ./client first
  python3 deploy_paramiko.py

Optional env:
  PRINCE_SSH_HOST  default 2.56.116.63
  PRINCE_SSH_USER  default root
"""
from __future__ import annotations

import os
import sys

try:
    import paramiko
except ImportError as e:
    print("Install paramiko: pip3 install paramiko", file=sys.stderr)
    raise SystemExit(1) from e

LOCAL_ROOT = os.path.dirname(os.path.abspath(__file__))
LOCAL_DIST = os.path.join(LOCAL_ROOT, "client", "dist")
REMOTE_BASE = os.environ.get("PRINCE_REMOTE_BASE", "/root/prince-music")
REMOTE_DIST = REMOTE_BASE + "/client/dist"
HOST = os.environ.get("PRINCE_SSH_HOST", "2.56.116.63")
USER = os.environ.get("PRINCE_SSH_USER", "root")
password = os.environ.get("PRINCE_SSH_PASS", "")
if not password:
    raise SystemExit("Missing PRINCE_SSH_PASS (export it before running)")


def mkdir_p(sftp: paramiko.SFTPClient, remote_dir: str) -> None:
    parts = [p for p in remote_dir.split("/") if p]
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except OSError:
            sftp.mkdir(cur)


def upload_tree(sftp: paramiko.SFTPClient, local_dir: str, remote_dir: str) -> None:
    for root, _dirs, files in os.walk(local_dir):
        rel = os.path.relpath(root, local_dir)
        rem_sub = remote_dir if rel == "." else remote_dir + "/" + rel.replace(os.sep, "/")
        mkdir_p(sftp, rem_sub)
        for name in files:
            sftp.put(os.path.join(root, name), rem_sub + "/" + name)


def main() -> None:
    if not os.path.isdir(LOCAL_DIST):
        raise SystemExit(f"Missing {LOCAL_DIST} — run: cd client && npm run build")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=password, timeout=30)
    try:
        stdin, stdout, stderr = c.exec_command(f"rm -rf {REMOTE_DIST} && mkdir -p {REMOTE_DIST}")
        stdout.channel.recv_exit_status()
        sftp = c.open_sftp()
        try:
            sftp.put(os.path.join(LOCAL_ROOT, "server.js"), REMOTE_BASE + "/server.js")
            mkdir_p(sftp, REMOTE_DIST.rsplit("/", 1)[0])
            upload_tree(sftp, LOCAL_DIST, REMOTE_DIST)
            presets = os.path.join(LOCAL_ROOT, "data", "create_house_presets.json")
            if os.path.isfile(presets):
                mkdir_p(sftp, REMOTE_BASE + "/data")
                sftp.put(presets, REMOTE_BASE + "/data/create_house_presets.json")
        finally:
            sftp.close()
        print("Uploaded server.js + client/dist (+ data/create_house_presets.json if present)")
        stdin, stdout, stderr = c.exec_command(
            f"cd {REMOTE_BASE} && pm2 restart prince-music && sleep 4 && pm2 status"
        )
        print(stdout.read().decode())
        err = stderr.read().decode()
        if err.strip():
            print("stderr:", err)
    finally:
        c.close()


if __name__ == "__main__":
    main()
