# canary-system/src/db_canary/listener.py
# Derived from: db-canary-mesh/SKILL.md — LISTEN/NOTIFY Canary Alert Consumer
"""
PostgreSQL LISTEN/NOTIFY consumer for real-time canary alert detection.
Receives pg_notify events from canary triggers and forwards them
to the sentinel for signing and shipping.
"""

import json
import logging
import os
import select
import time

import psycopg2
import psycopg2.extensions
from kafka import KafkaProducer

logger = logging.getLogger("db_canary.listener")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)


class PostgresCanaryListener:
    """Listens for PostgreSQL NOTIFY events from canary triggers."""

    def __init__(self):
        self.conn_string = os.environ.get(
            "CANARY_DB_CONN",
            "postgres://canary_monitor:canary_dev_password@localhost:5432/canarydb",
        )
        self.kafka_brokers = os.environ.get(
            "CANARY_KAFKA_BROKERS", "kafka-0:9092"
        ).split(",")
        self.conn = None
        self.producer = None
        self._max_reconnect_delay = 60

    def start(self):
        """Start listening for canary alerts."""
        self._connect_kafka()
        self._connect_and_listen()

    def _connect_kafka(self):
        """Connect to Kafka for forwarding events."""
        self.producer = KafkaProducer(
            bootstrap_servers=self.kafka_brokers,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        )
        logger.info("Connected to Kafka: %s", self.kafka_brokers)

    def _connect_and_listen(self):
        """Connect to PostgreSQL and listen with reconnect logic."""
        reconnect_delay = 1

        while True:
            try:
                self.conn = psycopg2.connect(self.conn_string)
                self.conn.set_isolation_level(
                    psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT
                )
                cur = self.conn.cursor()
                cur.execute("LISTEN canary_alert;")
                logger.info("Listening for canary_alert NOTIFY events...")
                reconnect_delay = 1  # Reset on successful connect

                self._poll_loop()

            except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                logger.error(
                    "PostgreSQL connection lost: %s — reconnecting in %ds",
                    e, reconnect_delay,
                )
                time.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, self._max_reconnect_delay)

            except Exception as e:
                logger.error("Unexpected error: %s", e)
                time.sleep(5)

    def _poll_loop(self):
        """Poll for NOTIFY events."""
        while True:
            if select.select([self.conn], [], [], 5) == ([], [], []):
                # Timeout — keep alive and loop
                continue

            self.conn.poll()
            while self.conn.notifies:
                notify = self.conn.notifies.pop(0)
                self._handle_notification(notify)

    def _handle_notification(self, notify):
        """Process a single NOTIFY event."""
        try:
            alert = json.loads(notify.payload)
            logger.warning(
                "DB CANARY ALERT: table=%s user=%s addr=%s",
                alert.get("table"), alert.get("user"), alert.get("addr"),
            )

            # Build event for sentinel/Kafka
            event = {
                "type": "DB_CANARY_ACCESS",
                "source": "postgres_notify",
                "channel": notify.channel,
                **alert,
            }

            # Ship directly to Kafka
            self.producer.send("canary-events", value=event)
            self.producer.flush()

        except json.JSONDecodeError as e:
            logger.error("Invalid NOTIFY payload: %s — %s", notify.payload, e)
        except Exception as e:
            logger.error("Error handling notification: %s", e)


def main():
    listener = PostgresCanaryListener()
    listener.start()


if __name__ == "__main__":
    main()
