# canary-system/src/db_canary/mysql_watcher.py
# Derived from: db-canary-mesh/SKILL.md — MySQL General Log Tail Watcher
"""
MySQL general log watcher — tails the MySQL general log and fires
alerts on canary table access patterns.
"""

import json
import logging
import os
import re

import tailer
from kafka import KafkaProducer

logger = logging.getLogger("db_canary.mysql_watcher")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

# Canary access patterns to detect in MySQL general log
CANARY_PATTERNS = [
    re.compile(r"_internal_config\.", re.IGNORECASE),
    re.compile(r"FROM\s+api_keys", re.IGNORECASE),
    re.compile(r"SHOW\s+DATABASES", re.IGNORECASE),
    re.compile(r"information_schema\.tables", re.IGNORECASE),
    re.compile(r"information_schema\.columns", re.IGNORECASE),
    re.compile(r"_financial_archive\.", re.IGNORECASE),
    re.compile(r"_system_config\.", re.IGNORECASE),
]


class MySQLLogWatcher:
    """Tails MySQL general log and fires alerts on canary table access."""

    def __init__(self):
        self.log_path = os.environ.get(
            "MYSQL_GENERAL_LOG", "/var/log/mysql/general.log"
        )
        self.kafka_brokers = os.environ.get(
            "CANARY_KAFKA_BROKERS", "kafka-0:9092"
        ).split(",")
        self.producer = None

    def start(self):
        """Start watching the MySQL general log."""
        self.producer = KafkaProducer(
            bootstrap_servers=self.kafka_brokers,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        )
        logger.info("MySQL log watcher started (log: %s)", self.log_path)

        self._watch_log()

    def _watch_log(self):
        """Tail the log file and check each line against canary patterns."""
        try:
            log_file = open(self.log_path)
        except FileNotFoundError:
            logger.error("MySQL general log not found: %s", self.log_path)
            return

        for line in tailer.follow(log_file):
            for pattern in CANARY_PATTERNS:
                if pattern.search(line):
                    self._fire_alert(line.strip(), pattern.pattern)
                    break

    def _fire_alert(self, log_line: str, matched_pattern: str):
        """Send a canary alert event to Kafka."""
        event = {
            "type": "DB_CANARY_ACCESS",
            "source": "mysql_general_log",
            "line": log_line,
            "matched_pattern": matched_pattern,
        }

        logger.warning("MySQL CANARY ALERT: %s", log_line[:200])

        try:
            self.producer.send("canary-events", value=event)
            self.producer.flush()
        except Exception as e:
            logger.error("Failed to send event to Kafka: %s", e)


def main():
    watcher = MySQLLogWatcher()
    watcher.start()


if __name__ == "__main__":
    main()
