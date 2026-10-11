#!/usr/bin/env python3
# test-env/stdin_injector.py
# High-performance standard input audit record generator for mock load testing.

import sys
import time
import argparse
import random

# Example paths to generate
CANARY_PATHS = [
    "/var/backups/pg_dump_prod_2024.sql.gz",
    "/etc/app/app.conf.bak",
    "/home/deploy/.ssh/id_ed25519_deploy.old",
    "/opt/app/config/app_secrets.env"
]

NOISE_PATHS = [
    "/var/log/nginx/access.log",
    "/var/log/syslog",
    "/etc/passwd",
    "/usr/share/man/man1/ls.1.gz",
    "/lib/x86_64-linux-gnu/libc.so.6",
    "/usr/bin/grep",
    "/home/vagrant/.bashrc",
    "/var/lib/dpkg/status"
]

def generate_records(event_idx, path, is_canary):
    """
    Returns a list of raw audit lines for a single event.
    """
    ts = time.time()
    audit_id = f"{ts:.3f}:{event_idx}"
    
    # Use syscall=2 (open) or syscall=257 (openat)
    sys_num = 2 if random.random() > 0.5 else 257
    
    syscall_line = (
        f"type=SYSCALL msg=audit({audit_id}): arch=c000003e syscall={sys_num} success=yes exit=3 "
        f"a0=7ffd588f9db0 a1=241 a2=1b6 a3=7ffd588f9a20 items=1 ppid=1234 pid=35635 auid=1000 "
        f"uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 "
        f"tty=pts0 ses=3 comm=\"bash\" exe=\"/usr/bin/bash\" key=\"sys-integrity\""
    )
    
    path_line = (
        f"type=PATH msg=audit({audit_id}): item=0 name=\"{path}\" inode={random.randint(1000, 99999)} "
        f"dev=08:01 mode=0100644 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL"
    )
    
    return [syscall_line, path_line]

def main():
    parser = argparse.ArgumentParser(description="Auditd Stdin High-Load Record Injector")
    parser.add_argument("--rate", type=int, default=10000, help="Event rate (events/second)")
    parser.add_argument("--duration", type=int, default=10, help="Injection duration in seconds")
    parser.add_argument("--canary-ratio", type=float, default=0.01, help="Ratio of canary hits to noise hits")
    args = parser.parse_args()

    # Rate translates to events per second.
    # Each event has 2 records (SYSCALL + PATH).
    
    target_count = args.rate * args.duration
    interval = 1.0 / args.rate
    
    sys.stderr.write(f"=== Starting High-Load Stdin Injection ===\n")
    sys.stderr.write(f"Target Event Rate: {args.rate} events/sec ({args.rate * 2} records/sec)\n")
    sys.stderr.write(f"Duration         : {args.duration}s\n")
    sys.stderr.write(f"Total Events     : {target_count}\n")
    sys.stderr.write(f"Canary Ratio     : {args.canary_ratio * 100:.2f}%\n")
    sys.stderr.write(f"--------------------------------------------------\n")

    event_idx = 100000
    start_time = time.time()
    next_event_time = start_time

    while event_idx < (100000 + target_count):
        # Decide if this is a canary or noise
        if random.random() < args.canary_ratio:
            path = random.choice(CANARY_PATHS)
            is_canary = True
        else:
            path = random.choice(NOISE_PATHS)
            is_canary = False
            
        records = generate_records(event_idx, path, is_canary)
        for rec in records:
            sys.stdout.write(rec + "\n")
        sys.stdout.flush()
        
        event_idx += 1

    elapsed = time.time() - start_time
    actual_rate = (event_idx - 100000) / elapsed
    sys.stderr.write(f"--------------------------------------------------\n")
    sys.stderr.write(f"Stdin Injection Completed ✓\n")
    sys.stderr.write(f"Elapsed Time       : {elapsed:.2f}s\n")
    sys.stderr.write(f"Actual Event Rate  : {actual_rate:.2f} events/sec\n")

if __name__ == "__main__":
    main()
