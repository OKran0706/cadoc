package main

import (
	"log"
	"time"

	"github.com/your-org/canary/sentinel/internal/auditmon"
	"github.com/elastic/go-libaudit/auparse"
)

func main() {
	agg := auditmon.NewAggregator(2*time.Second, 10000)

	log.Println("Feeding record...")
	rec, _ := auparse.Parse(0, "type=SYSCALL msg=audit(1714295828.000:123): arch=c000003e syscall=2 success=yes exit=3 a0=7ffcd5a2b000 a1=0 a2=0 a3=0 items=1 ppid=1234 pid=5678 auid=1000 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=pts0 ses=1 comm=\"cat\" exe=\"/usr/bin/cat\" key=\"canary\"")
	agg.ProcessRecord(rec)

	log.Println("Waiting for event...")
	select {
	case event := <-agg.Events():
		log.Printf("Got event: %+v", event)
	case <-time.After(5 * time.Second):
		log.Printf("Timeout waiting for event! Channel length: %d", len(agg.Events()))
	}
}
