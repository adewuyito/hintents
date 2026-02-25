// Copyright 2025 Erst Users
// SPDX-License-Identifier: Apache-2.0

package sourcemap

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dotandev/hintents/internal/logger"
)

// Resolver coordinates fetching verified source code from a registry,
// with optional local caching. It is the primary entry point for
// downstream consumers that need contract source code.
type Resolver struct {
	registry *RegistryClient
	cache    *SourceCache
}

// ResolverOption is a functional option for configuring the Resolver.
type ResolverOption func(*Resolver)

// WithCache enables caching with the specified directory.
func WithCache(cacheDir string) ResolverOption {
	return func(r *Resolver) {
		cache, err := NewSourceCache(filepath.Join(cacheDir, "sourcemap"))
		if err != nil {
			logger.Logger.Warn("Failed to create source cache, caching disabled", "error", err)
			return
		}
		r.cache = cache
	}
}

// WithRegistryClient sets a custom registry client.
func WithRegistryClient(rc *RegistryClient) ResolverOption {
	return func(r *Resolver) {
		r.registry = rc
	}
}

// NewResolver creates a Resolver with the given options.
func NewResolver(opts ...ResolverOption) *Resolver {
	r := &Resolver{
		registry: NewRegistryClient(),
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// Resolve attempts to find verified source code for the given contract ID.
// It checks the local cache first, then queries the registry.
// If both fail, it prompts the user for a manual WASM path (Issue #372).
func (r *Resolver) Resolve(ctx context.Context, contractID string) (*SourceCode, error) {
	if err := validateContractID(contractID); err != nil {
		return nil, fmt.Errorf("invalid contract ID: %w", err)
	}

	// 1. Check cache first
	if r.cache != nil {
		if cached := r.cache.Get(contractID); cached != nil {
			logger.Logger.Info("Source resolved from cache", "contract_id", contractID)
			return cached, nil
		}
	}

	// 2. Fetch from registry
	source, err := r.registry.FetchVerifiedSource(ctx, contractID)
	if err != nil {
		// Log the error but continue to fallback
		logger.Logger.Debug("Registry lookup failed", "contract_id", contractID, "error", err)
	}

	// 3. Fallback: Prompt user if source is unresolved (Issue #372)
	if source == nil {
		logger.Logger.Info("Contract source unresolved automatically", "contract_id", contractID)
		
		manualPath, err := r.PromptForWasmPath()
		if err != nil {
			return nil, fmt.Errorf("failed to get manual WASM path: %w", err)
		}

		if manualPath != "" {
			// In a real scenario, you might attempt to load symbols from this path 
			// using the dwarf.Parser here. For now, we log the path as per requirements.
			logger.Logger.Info("Manual WASM path provided by user", "path", manualPath)
		}
		
		return nil, nil
	}

	// 4. Cache the result
	if r.cache != nil {
		if err := r.cache.Put(source); err != nil {
			logger.Logger.Warn("Failed to cache source", "contract_id", contractID, "error", err)
		}
	}

	logger.Logger.Info("Source resolved from registry",
		"contract_id", contractID,
		"repository", source.Repository,
		"file_count", len(source.Files),
	)

	return source, nil
}

// PromptForWasmPath pauses execution and asks the user for a manual WASM path.
// Requirement: If erst encounters an unknown contract, pause and ask the user 
// "Please provide path to contract WASM for better mapping".
func (r *Resolver) PromptForWasmPath() (string, error) {
	// Exact string required by Issue #372
	fmt.Print("Please provide path to contract WASM for better mapping: ")
	
	reader := bufio.NewReader(os.Stdin)
	path, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}

	return strings.TrimSpace(path), nil
}

// InvalidateCache removes a specific contract from the cache.
func (r *Resolver) InvalidateCache(contractID string) error {
	if r.cache == nil {
		return nil
	}
	return r.cache.Invalidate(contractID)
}

// ClearCache removes all cached source entries.
func (r *Resolver) ClearCache() error {
	if r.cache == nil {
		return nil
	}
	return r.cache.Clear()
}