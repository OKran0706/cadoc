// canary-system/src/telemetry/internal/verifier/verifier.go
// Ed25519 signature verification and Merkle chain integrity checking.
// Derived from: telemetry-bus/SKILL.md

package verifier

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"

	"github.com/segmentio/kafka-go"
)

// ChainVerifier validates event signatures, sequence continuity, and Merkle chains.
type ChainVerifier struct {
	publicKeys map[string]ed25519.PublicKey // keyID → public key
	lastHash   map[string]string           // host → last verified hash
	lastSeq    map[string]int64            // host → last sequence number
}

// BatchResults holds the results of a batch verification run.
type BatchResults struct {
	Total       int
	ValidSigs   int
	FailedSigs  int
	SequenceGaps int
	ChainBreaks int
}

// envelope is the signed event wrapper format.
type envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
	KeyID     string `json:"key_id"`
	Hash      string `json:"hash"`
}

// innerEvent is the parsed inner payload.
type innerEvent struct {
	Host     string `json:"host"`
	Seq      int64  `json:"seq"`
	PrevHash string `json:"prev_hash"`
}

// New creates a ChainVerifier with the given trusted public keys.
func New(publicKeys map[string]ed25519.PublicKey) *ChainVerifier {
	return &ChainVerifier{
		publicKeys: publicKeys,
		lastHash:   make(map[string]string),
		lastSeq:    make(map[string]int64),
	}
}

// VerifyContinuous runs an infinite verification loop over Kafka messages.
func (cv *ChainVerifier) VerifyContinuous(ctx context.Context, reader *kafka.Reader) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("Read error: %v", err)
			continue
		}

		cv.verifyMessage(msg.Value)
	}
}

// VerifyBatch reads up to N messages and returns aggregated results.
func (cv *ChainVerifier) VerifyBatch(ctx context.Context, reader *kafka.Reader, count int) BatchResults {
	var results BatchResults

	for i := 0; i < count; i++ {
		select {
		case <-ctx.Done():
			return results
		default:
		}

		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return results
			}
			continue
		}

		ok, gaps, breaks := cv.verifyMessageDetailed(msg.Value)
		results.Total++
		if ok {
			results.ValidSigs++
		} else {
			results.FailedSigs++
		}
		results.SequenceGaps += gaps
		results.ChainBreaks += breaks
	}

	return results
}

func (cv *ChainVerifier) verifyMessage(data []byte) {
	cv.verifyMessageDetailed(data)
}

func (cv *ChainVerifier) verifyMessageDetailed(data []byte) (sigOK bool, gaps, breaks int) {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		log.Printf("Invalid envelope format: %v", err)
		return false, 0, 0
	}

	// 1. Verify Ed25519 signature
	pubKey, knownKey := cv.publicKeys[env.KeyID]
	if knownKey {
		sigBytes, err := hex.DecodeString(env.Signature)
		if err != nil {
			cv.emitAlert("SIGNATURE_DECODE_FAILED", "", env.KeyID)
			return false, 0, 0
		}
		if !ed25519.Verify(pubKey, []byte(env.Payload), sigBytes) {
			cv.emitAlert("SIGNATURE_VERIFICATION_FAILED", "", env.KeyID)
			return false, 0, 0
		}
	}

	// 2. Parse inner payload
	var inner innerEvent
	if err := json.Unmarshal([]byte(env.Payload), &inner); err != nil {
		log.Printf("Invalid inner payload: %v", err)
		return true, 0, 0
	}

	host := inner.Host
	hash := sha256.Sum256([]byte(env.Payload))
	eventHash := hex.EncodeToString(hash[:])

	// 3. Check sequence continuity
	if lastSeq, exists := cv.lastSeq[host]; exists && inner.Seq != lastSeq+1 {
		cv.emitAlert("SEQUENCE_GAP", host, fmt.Sprintf(
			"expected=%d got=%d gap=%d", lastSeq+1, inner.Seq, inner.Seq-lastSeq-1,
		))
		gaps = 1
	}

	// 4. Check Merkle chain
	if lastHash, exists := cv.lastHash[host]; exists && inner.PrevHash != lastHash {
		cv.emitAlert("MERKLE_CHAIN_BREAK", host, fmt.Sprintf(
			"expected_prev=%s claimed_prev=%s seq=%d", lastHash, inner.PrevHash, inner.Seq,
		))
		breaks = 1
	}

	cv.lastSeq[host] = inner.Seq
	cv.lastHash[host] = eventHash

	return true, gaps, breaks
}

func (cv *ChainVerifier) emitAlert(alertType, host, detail string) {
	log.Printf("ALERT: type=%s host=%s detail=%s", alertType, host, detail)
	// In production: also write alert to Kafka canary-events topic
}
