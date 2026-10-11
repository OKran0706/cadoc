#!/usr/bin/env python3
# test-env/stress_generator.py
# Multithreaded file I/O stress workload generator for watched audit directories.

import os
import sys
import time
import argparse
import random
import concurrent.futures

def worker(worker_id, target_dir, duration, rate_limit):
    """
    Simulates intensive local file I/O in a target directory.
    """
    end_time = time.time() + duration
    ops_completed = 0
    start = time.time()

    # Generate distinct filenames for this worker
    filenames = [os.path.join(target_dir, f"stress_t_{worker_id}_{i}.tmp") for i in range(10)]

    while time.time() < end_time:
        try:
            op_type = random.choice(["write", "read", "delete"])
            filepath = random.choice(filenames)

            if op_type == "write":
                # Trigger a write/create event
                with open(filepath, "w") as f:
                    f.write(f"stress payload from worker {worker_id} - {random.randint(1000, 9999)}\n")
            elif op_type == "read":
                # Trigger a read event
                if os.path.exists(filepath):
                    with open(filepath, "r") as f:
                        _ = f.read()
            elif op_type == "delete":
                # Trigger a delete event
                if os.path.exists(filepath):
                    os.remove(filepath)

            ops_completed += 1

            # Sleep briefly to rate limit if configured
            if rate_limit > 0:
                time.sleep(1.0 / rate_limit)
        except Exception as e:
            # Silently capture issues (like deleting a non-existent file)
            pass

    # Cleanup any leftovers
    for filepath in filenames:
        try:
            if os.path.exists(filepath):
                os.remove(filepath)
        except:
            pass

    elapsed = time.time() - start
    return ops_completed, elapsed

def main():
    parser = argparse.ArgumentParser(description="Auditd Syscall Workload Stress Generator")
    parser.add_argument("--dir", default="/var/backups", help="Target watched directory")
    parser.add_argument("--workers", type=int, default=8, help="Number of concurrent workers")
    parser.add_argument("--duration", type=int, default=30, help="Test duration in seconds")
    parser.add_argument("--rate", type=float, default=100.0, help="Max rate of ops/sec per worker")
    args = parser.parse_args()

    print(f"=== Starting Syscall Storm Stress Workload ===")
    print(f"Target Directory : {args.dir}")
    print(f"Workers          : {args.workers}")
    print(f"Duration         : {args.duration}s")
    print(f"Target Rate/W    : {args.rate} ops/sec")
    print(f"--------------------------------------------------")

    # Ensure target directory exists
    os.makedirs(args.dir, exist_ok=True)

    start_total = time.time()
    total_ops = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = []
        for i in range(args.workers):
            futures.append(
                executor.submit(worker, i, args.dir, args.duration, args.rate)
            )

        for future in concurrent.futures.as_completed(futures):
            ops, elapsed = future.result()
            total_ops += ops

    elapsed_total = time.time() - start_total
    overall_throughput = total_ops / elapsed_total

    print(f"--------------------------------------------------")
    print(f"Syscall Storm Completed ✓")
    print(f"Total I/O Operations: {total_ops}")
    print(f"Elapsed Time         : {elapsed_total:.2f}s")
    print(f"Overall Throughput   : {overall_throughput:.2f} ops/sec")

if __name__ == "__main__":
    main()
