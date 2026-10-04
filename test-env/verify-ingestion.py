import redis
import time
import subprocess
import json

REDIS_HOST = 'localhost'
REDIS_PORT = 6379
SENTINEL_ID = 'sentinel-a'

def check_redis():
    print(f"Connecting to Redis at {REDIS_HOST}:{REDIS_PORT}...")
    try:
        r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
        key = f"sentinel:{SENTINEL_ID}"
        val = r.get(key)
        if val:
            print(f"✅ FOUND liveness key in Redis: {key} -> {val}")
            return True
        else:
            print(f"❌ Key {key} NOT FOUND in Redis.")
            return False
    except Exception as e:
        print(f"❌ Redis connection error: {e}")
        return False

def check_logs():
    print("Checking Sentinel-A logs for heartbeat activity...")
    try:
        # Check logs of the container
        result = subprocess.run(['docker', 'logs', 'canary-sentinel-a', '--tail', '20'], capture_output=True, text=True)
        if "SENTINEL_HEARTBEAT" in result.stdout:
            print("✅ FOUND Heartbeat events in Sentinel-A logs.")
            return True
        else:
            print("❌ No heartbeats found in current log tail.")
            return False
    except Exception as e:
        print(f"❌ Error reading docker logs: {e}")
        return False

if __name__ == "__main__":
    print("=== Milestone v1.2 Ingestion Verification ===")
    
    # Wait a moment for startup
    time.sleep(5)
    
    log_ok = check_logs()
    redis_ok = check_redis()
    
    if log_ok and redis_ok:
        print("\n🏆 VERIFICATION PASSED: End-to-end telemetry pipeline is active.")
    else:
        print("\n⚠️ VERIFICATION FAILED: Check the infrastructure logs.")
