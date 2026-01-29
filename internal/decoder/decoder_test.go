// Copyright 2025 Erst Users
// SPDX-License-Identifier: Apache-2.0

package decoder

import (
	"encoding/base64"
	"testing"

	"github.com/stellar/go/xdr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createEvent(t *testing.T, fnName string, isCall bool, isReturn bool) string {
	topics := []xdr.ScVal{}
	fnSym := xdr.ScSymbol(fnName)
	
	if isCall {
		callSym := xdr.ScSymbol("fn_call")
		topics = append(topics, xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &callSym})
		topics = append(topics, xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &fnSym})
	} else if isReturn {
		retSym := xdr.ScSymbol("fn_return")
		topics = append(topics, xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &retSym})
		topics = append(topics, xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &fnSym})
	} else {
		logSym := xdr.ScSymbol("log")
		topics = append(topics, xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &logSym})
		topics = append(topics, xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &fnSym})
	}

	diag := xdr.DiagnosticEvent{
		InSuccessfulContractCall: true,
		Event: xdr.ContractEvent{
			Type: xdr.ContractEventTypeDiagnostic,
			Body: xdr.ContractEventBody{
				V: 0,
				V0: &xdr.ContractEventV0{
					Topics: topics,
					Data:   xdr.ScVal{Type: xdr.ScValTypeScvVoid},
				},
			},
		},
	}

	bytes, err := diag.MarshalBinary()
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(bytes)
}

func TestDecodeEvents(t *testing.T) {
	// A calls B, B returns, A returns
	events := []string{
		createEvent(t, "A", true, false),
		createEvent(t, "log_in_A", false, false),
		createEvent(t, "B", true, false),
		createEvent(t, "log_in_B", false, false),
		createEvent(t, "B", false, true),
		createEvent(t, "A", false, true),
	}

	root, err := DecodeEvents(events)
	require.NoError(t, err)

	assert.Equal(t, "TOP_LEVEL", root.Function)
	require.Len(t, root.SubCalls, 1)

	nodeA := root.SubCalls[0]
	assert.Equal(t, "A", nodeA.Function)
	// Expecting 3 events: fn_call A, log_in_A, fn_return A
	require.Len(t, nodeA.Events, 3) 
	
	assert.Equal(t, "A", nodeA.Events[0].Topics[1]) 
	assert.Equal(t, "log_in_A", nodeA.Events[1].Topics[1]) 
	assert.Equal(t, "A", nodeA.Events[2].Topics[1]) 
	
	require.Len(t, nodeA.SubCalls, 1)
	nodeB := nodeA.SubCalls[0]
	assert.Equal(t, "B", nodeB.Function)
	// Expecting 3 events: fn_call B, log_in_B, fn_return B
	assert.Len(t, nodeB.Events, 3) 
}

func TestUnbalanced(t *testing.T) {
	// A calls B, B crashes (no return), A returns
	events := []string{
		createEvent(t, "A", true, false),
		createEvent(t, "B", true, false),
		createEvent(t, "A", false, true),
	}

	root, err := DecodeEvents(events)
	require.NoError(t, err)

	nodeA := root.SubCalls[0]
	assert.Equal(t, "A", nodeA.Function)

	require.Len(t, nodeA.SubCalls, 1)
	nodeB := nodeA.SubCalls[0]
	assert.Equal(t, "B", nodeB.Function)
	// B has call event, but no return event
	assert.Len(t, nodeB.Events, 1)
	
	// A should have call + return (no log)
	assert.Len(t, nodeA.Events, 2)
}
